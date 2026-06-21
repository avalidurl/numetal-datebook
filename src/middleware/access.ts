/**
 * Operator access gate. Two ways in, NEVER a key in a URL:
 *  1. Cloudflare Access email login — on the operator domain, Cloudflare validates the
 *     email one-time-PIN at the edge and injects a signed JWT (Cf-Access-Jwt-Assertion /
 *     CF_Authorization cookie). We verify it (aud + iss + signature). This is the human path.
 *  2. Bearer ACCESS_KEY in the Authorization header — for API/agents/tooling.
 * No ?key= query fallback: secrets must not appear in URLs/logs/history.
 */
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import { verifyAccessJwt } from "../identity/cfaccess";

export const accessGate = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  // 1) Cloudflare Access (email) — the operator path.
  const assertion = c.req.header("cf-access-jwt-assertion") ?? getCookie(c, "CF_Authorization");
  if (assertion && (await verifyAccessJwt(c.env, assertion)).ok) {
    await next();
    return;
  }
  // 2) Bearer ACCESS_KEY — the API/agent path.
  const auth = c.req.header("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined;
  if (c.env.ACCESS_KEY && bearer === c.env.ACCESS_KEY) {
    await next();
    return;
  }
  return c.json({ error: "locked. this venue opens when the founder says so." }, 403);
});
