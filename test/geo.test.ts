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

describe("status-probe geo exemption", () => {
  const probe = "probe";
  const probeReq = (country: string, path: string, secret?: string) =>
    new Request(`https://datebook.example${path}`, {
      cf: { country },
      headers: secret ? { "x-status-probe": secret } : {},
    });

  it("the correct secret lets a denied-country probe reach a liveness path", async () => {
    (env as { STATUS_PROBE_SECRET?: string }).STATUS_PROBE_SECRET = probe;
    const ctx = createExecutionContext();
    const res = await worker.fetch(probeReq("TR", "/health", probe), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    delete (env as { STATUS_PROBE_SECRET?: string }).STATUS_PROBE_SECRET;
  });

  it("a wrong secret is still geo-blocked", async () => {
    (env as { STATUS_PROBE_SECRET?: string }).STATUS_PROBE_SECRET = probe;
    const ctx = createExecutionContext();
    const res = await worker.fetch(probeReq("TR", "/health", "wrong"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
    delete (env as { STATUS_PROBE_SECRET?: string }).STATUS_PROBE_SECRET;
  });

  it("the secret does NOT exempt a non-liveness path", async () => {
    (env as { STATUS_PROBE_SECRET?: string }).STATUS_PROBE_SECRET = probe;
    const ctx = createExecutionContext();
    const res = await worker.fetch(probeReq("TR", "/api/intake", probe), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
    delete (env as { STATUS_PROBE_SECRET?: string }).STATUS_PROBE_SECRET;
  });
});
