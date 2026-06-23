/**
 * Edge geo gate (audit blocker) — MUST run before auth/D1/x402. Hard-denies a founder-set list
 * of 15 jurisdictions (CU,IR,KP,GB,IN,BD,ID,EG,PS,NG,SA,YE,PK,AF,SG — see GEO_DENY). TR is
 * intentionally NOT blocked (founder operates from there). Logs to access_denials and returns a
 * generic 403 (never reveals denylist internals).
 */
import { createMiddleware } from "hono/factory";
import { db as makeDb } from "../db/client";
import { accessDenials } from "../db/schema";
import type { Env } from "../env";
import { geoBlockPage, wantsHtml } from "../ui/system-pages";

export const geoGate = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const cf = (c.req.raw as { cf?: IncomingRequestCfProperties }).cf;
  const country = (cf?.country as string | undefined) ?? "XX";
  const region = (cf?.regionCode as string | undefined) ?? null;
  const deny = new Set(
    c.env.GEO_DENY.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
  );

  if (deny.has(country.toUpperCase())) {
    // Best-effort audit; never block the response on a logging failure.
    try {
      await makeDb(c.env.DB)
        .insert(accessDenials)
        .values({
          country,
          region,
          routeClass: c.req.path.startsWith("/api/premium") ? "payment" : "public",
          reason: "geo_denied",
        })
        .run();
    } catch {
      /* swallow */
    }
    // Browsers get a calm, on-brand datasheet page; API clients keep the generic JSON.
    if (wantsHtml(c.req.header("accept"))) return c.html(geoBlockPage(), 403);
    return c.json({ error: "service unavailable in this location" }, 403);
  }

  // Red-team M6: fail-CLOSED on UNKNOWN geo for sensitive/regulated routes — if we can't determine
  // the jurisdiction, we don't serve the gated functionality (claim, age, intake, payments,
  // escalations). Public surfaces (landing, /health, MCP, read-only stats) stay reachable.
  if (
    (country === "XX" || !country) &&
    /^\/(claim$|api\/(age|intake|premium|escalations|personas))/.test(c.req.path)
  ) {
    if (wantsHtml(c.req.header("accept"))) return c.html(geoBlockPage(), 403);
    return c.json({ error: "service unavailable in this location" }, 403);
  }
  await next();
});
