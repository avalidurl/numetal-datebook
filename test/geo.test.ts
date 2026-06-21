import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const req = (country: string) =>
  new Request("https://datebook.example/health", { cf: { country } });

describe("edge geo gate", () => {
  it("blocks a denied country (TR — founder geo rule) before anything", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(req("TR"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
  });

  it("lets a permitted country reach /health (geo-only, no key needed)", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(req("US"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
