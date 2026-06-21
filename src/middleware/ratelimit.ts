/**
 * Edge rate limit on sensitive write routes (committee/privacy finding: no abuse controls on
 * any public surface). Uses Cloudflare's native Workers rate-limiting binding (RATE_LIMITER,
 * GA 2025-09) keyed by client IP + a route class, so one source can't flood intake/payments/
 * claims or amplify inference cost. No-op when the binding is absent (local/test). Denials are
 * recorded in access_denials for the operator console.
 */
import type { Context, Next } from "hono";
import { db as makeDb } from "../db/client";
import { accessDenials } from "../db/schema";
import type { Env } from "../env";

export function rateLimit(routeClass: string) {
  return async (c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> => {
    const limiter = c.env.RATE_LIMITER;
    if (!limiter) return next();
    const ip = c.req.header("cf-connecting-ip") ?? "0.0.0.0";
    const { success } = await limiter.limit({ key: `${routeClass}:${ip}` });
    if (success) return next();
    try {
      await makeDb(c.env.DB)
        .insert(accessDenials)
        .values({
          country: (c.req.raw.cf?.country as string | undefined) ?? null,
          routeClass,
          reason: "rate_limited",
          actorRef: ip,
        })
        .run();
    } catch {
      /* never fail the request path on a logging error */
    }
    return c.json({ error: "rate limited — slow down" }, 429);
  };
}
