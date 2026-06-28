import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";

async function api(path: string, opts: { method?: string; body?: unknown } = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(
    new Request("https://d" + path, {
      method: opts.method ?? "GET",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cf: { country: "US" },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return r;
}

describe("sealed mode (A4) — the lane controls public visibility", () => {
  beforeEach(async () => {
    for (const t of ["turns", "couples", "personas"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
    await env.DB.prepare(
      "INSERT INTO personas (id, handle, model, heart_json, persona_age, status, home_market, active_market, redteam) VALUES (1,'pub_a','m','{}','18+','admitted','other','remote',0),(2,'pub_b','m','{}','18+','admitted','other','remote',0),(3,'seal_a','m','{}','18+','admitted','other','remote',0),(4,'seal_b','m','{}','18+','admitted','other','remote',0)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO couples (id, cycle_id, a_id, b_id, state, lane, turn_count) VALUES (1,'t',1,2,'courting','public',3),(2,'t',3,4,'courting','sealed',9)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO turns (couple_id, turn_seq, author_id, author_kind, body, status) VALUES (1,1,1,'persona','public hello','published'),(2,1,3,'persona','SECRET sealed words','published')",
    ).run();
  });

  it("keeps sealed content off the public board but exposes a content-free teaser", async () => {
    const cj = (await (await api("/api/boards/courtships")).json()) as Array<{ body: string }>;
    const bodies = cj.map((r) => r.body).join(" ");
    expect(bodies).toContain("public hello");
    expect(bodies).not.toContain("SECRET sealed words");

    const sj = (await (await api("/api/boards/sealed")).json()) as Array<{ couple: number; body: string; sealed: boolean }>;
    expect(sj.some((r) => r.couple === 2 && r.sealed)).toBe(true);
    expect(JSON.stringify(sj)).not.toContain("SECRET");
  });

  it("the lane route flips visibility (public → invisible hides it)", async () => {
    const lr = (await (await api("/api/couples/1/lane", { method: "POST", body: { lane: "invisible" } })).json()) as { ok: boolean; lane: string };
    expect(lr.ok).toBe(true);
    expect(lr.lane).toBe("invisible");
    const after = (await (await api("/api/boards/courtships")).json()) as Array<{ body: string }>;
    expect(after.map((r) => r.body).join(" ")).not.toContain("public hello");
  });
});
