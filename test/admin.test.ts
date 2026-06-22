import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

// The console is served only on the admin.* host (CF-Access-gated in prod); target it so the
// host-lock redirect doesn't intercept the gate-behaviour these tests assert.
const req = (path: string, key?: string) =>
  new Request(`https://admin.ishtar.numetal.xyz${path}`, {
    headers: { host: "admin.ishtar.numetal.xyz", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    cf: { country: "US" },
  });

describe("admin single-pane dashboard", () => {
  it("serves /admin.json snapshot when authed", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(req("/admin.json", "test-key"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j.health).toBe("ok");
    expect(j).toHaveProperty("admitted");
    expect(j).toHaveProperty("daily_budget_usd");
    expect(j).toHaveProperty("budget_remaining_usd");
    expect(j).toHaveProperty("revenue_usdc");
  });

  it("blocks the dashboard without the access key", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(req("/admin.json"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
  });
});
