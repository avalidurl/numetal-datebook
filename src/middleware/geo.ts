/**
 * Edge geo gate (audit blocker) — MUST run before auth/D1/x402. Hard-denies OFAC-broad
 * + GB + TR ([redacted] → TR blocked for the public product). Logs to access_denials
 * and returns a generic 403 (never reveals denylist internals).
 */
import { createMiddleware } from "hono/factory";
import { db as makeDb } from "../db/client";
import { accessDenials } from "../db/schema";
import type { Env } from "../env";

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
    return c.json({ error: "service unavailable in this location" }, 403);
  }
  await next();
});
