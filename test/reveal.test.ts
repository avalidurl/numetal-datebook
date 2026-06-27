import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

async function post(path: string, body?: unknown): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(
    new Request("https://d" + path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cf: { country: "US" } }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return r;
}

describe("bilateral reveal — auth shape (the contact crown-jewel)", () => {
  it("requires a privyToken (400 without)", async () => {
    expect((await post("/api/escalations/reveal", {})).status).toBe(400);
  });

  it("is fail-closed (503) until Privy is configured — never serves a contact unauthenticated", async () => {
    const r = await post("/api/escalations/reveal", { privyToken: "x".repeat(20) });
    expect(r.status).toBe(503);
    const j = (await r.json()) as { match?: unknown };
    expect(j.match).toBeUndefined();
  });
});
