import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const ingest = (body: unknown, token?: string) =>
  new Request("https://api.ishtar.numetal.xyz/api/fuzz/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    cf: { country: "US" },
  });

const adminReq = (path: string, key?: string) =>
  new Request(`https://admin.ishtar.numetal.xyz${path}`, {
    headers: { host: "admin.ishtar.numetal.xyz", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    cf: { country: "US" },
  });

const RUN = {
  repo: "gokhan-vc/numetal-datebook",
  job: "coverage-guided",
  event: "schedule",
  branch: "main",
  commit_sha: "abcdef1234567890",
  conclusion: "success",
  crashes: 0,
  corpus_size: 812,
  exec_count: 4200000,
  duration_s: 900,
  run_url: "https://github.com/gokhan-vc/numetal-datebook/actions/runs/999",
  run_id: "999",
};

describe("fuzz ingest", () => {
  it("rejects ingest without the fuzz token", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(ingest(RUN), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("rejects the operator ACCESS_KEY on the ingest endpoint", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(ingest(RUN, "test-key"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("422s when required fields are missing", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(ingest({ repo: "x" }, "test-fuzz-token"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(422);
  });

  it("accepts a valid run and surfaces it in the admin console", async () => {
    let ctx = createExecutionContext();
    const res = await worker.fetch(ingest(RUN, "test-fuzz-token"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);

    // idempotent on (run_id, job)
    ctx = createExecutionContext();
    const res2 = await worker.fetch(ingest({ ...RUN, corpus_size: 900 }, "test-fuzz-token"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res2.status).toBe(200);

    ctx = createExecutionContext();
    const admin = await worker.fetch(adminReq("/admin", "test-key"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(admin.status).toBe(200);
    const html = await admin.text();
    expect(html).toContain("fuzzing (CI)");
    expect(html).toContain("coverage-guided");
    expect(html).toContain("900"); // updated corpus size from the upsert
  });

  it("flags a crash run (crashes>0)", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      ingest({ ...RUN, run_id: "1000", job: "property", conclusion: "failure", crashes: 2 }, "test-fuzz-token"),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect((await res.json() as { crashed: boolean }).crashed).toBe(true);
  });
});
