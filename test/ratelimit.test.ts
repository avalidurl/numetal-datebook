import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

/**
 * GOK-175 — the four public, pre-access-gate surfaces (nonce / waitlist / session / topup)
 * must pass through the `rateLimit(...)` middleware. The native RATE_LIMITER binding is absent
 * in the test runtime (the middleware no-ops), so we inject a stub limiter that always DENIES
 * and assert each route returns 429. That proves the middleware is wired on the path — if a
 * refactor ever drops a `rateLimit(...)` line, the matching case here goes red.
 */

// A RATE_LIMITER stub that denies every request — exercises the throttled branch.
const denyingLimiter = { limit: async () => ({ success: false }) };

// Permitted country (US is not in GEO_DENY) so the geo gate lets the request through to the route.
const post = (path: string, body: unknown = {}) =>
  new Request(`https://datebook.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify(body),
    cf: { country: "US" },
  });

const get = (path: string) =>
  new Request(`https://datebook.example${path}`, {
    headers: { "cf-connecting-ip": "203.0.113.7" },
    cf: { country: "US" },
  });

async function expect429(request: Request) {
  const ctx = createExecutionContext();
  // Spread the wrangler.test.toml env and add the denying RATE_LIMITER for this call only.
  const res = await worker.fetch(request, { ...env, RATE_LIMITER: denyingLimiter } as typeof env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("GOK-175 — rate-limit covers the 4 public surfaces", () => {
  it("GET /api/chat/nonce is throttled", async () => {
    const res = await expect429(get("/api/chat/nonce"));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate limited — slow down" });
  });

  it("POST /api/waitlist is throttled", async () => {
    const res = await expect429(post("/api/waitlist", { email: "a@b.co" }));
    expect(res.status).toBe(429);
  });

  it("POST /api/chat/session is throttled", async () => {
    const res = await expect429(post("/api/chat/session", { message: "x", signature: "0x", address: "0x" }));
    expect(res.status).toBe(429);
  });

  it("POST /api/chat/topup is throttled", async () => {
    const res = await expect429(post("/api/chat/topup", { ref: "abcdefgh" }));
    expect(res.status).toBe(429);
  });

  it("lets the same routes through when the limiter is absent (no-op binding)", async () => {
    // No RATE_LIMITER in env → middleware no-ops → request reaches the handler (not a 429).
    const ctx = createExecutionContext();
    const res = await worker.fetch(get("/api/chat/nonce"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).not.toBe(429);
  });
});
