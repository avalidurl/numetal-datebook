/**
 * Staging access gate (publication discipline). Accepts a Bearer token (preferred —
 * keeps the key out of query strings/logs) or a ?key= fallback. Founder gates go-live.
 */
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";

export const accessGate = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const auth = c.req.header("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined;
  const key = bearer ?? c.req.query("key");
  if (!c.env.ACCESS_KEY || key !== c.env.ACCESS_KEY) {
    return c.json({ error: "locked. this venue opens when the founder says so." }, 403);
  }
  await next();
});
