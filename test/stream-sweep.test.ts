import { env } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";
import { sweepStreamDemo } from "../src/stream/sweep";

// Seed helpers hitting the same D1 the Worker uses in the test pool.
async function mkStreamOwner(name: string, opts: Partial<{ tier: string; wallet: string }> = {}): Promise<number> {
  const r = await env.DB.prepare(
    "INSERT INTO owners (display_name, tier, home_market, active_market, research_optin, age_attested, status, public_chatter, wallet) VALUES (?1,?2,'other','remote','none',1,'admitted',1,?3) RETURNING id",
  )
    .bind(`stream-${name}`, opts.tier ?? "agent_represented", opts.wallet ?? null)
    .first<{ id: number }>();
  return r!.id;
}

describe("sweepStreamDemo — bounds the synthetic live-stream demo", () => {
  beforeEach(async () => {
    // clean slate for stream rows
    await env.DB.prepare("DELETE FROM owners WHERE display_name LIKE 'stream-%'").run();
  });

  it("deletes orphan stream owners (no persona), the exact leak shape", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await mkStreamOwner(`orphan${i}`));
    const before = await env.DB.prepare("SELECT COUNT(*) n FROM owners WHERE display_name LIKE 'stream-%'").first<{ n: number }>();
    expect(before!.n).toBeGreaterThanOrEqual(5);

    const res = await sweepStreamDemo(env);
    expect(res.owners).toBeGreaterThanOrEqual(5);

    const after = await env.DB.prepare("SELECT COUNT(*) n FROM owners WHERE display_name LIKE 'stream-%'").first<{ n: number }>();
    expect(after!.n).toBe(0);
  });

  it("NEVER deletes a stream-* owner that carries a real signal (promoted tier / wallet / heart-file)", async () => {
    const promoted = await mkStreamOwner("sable", { tier: "profile_claimed" }); // the #9013-style case
    const walleted = await mkStreamOwner("wal", { wallet: "0xabc" });
    await mkStreamOwner("throwaway"); // pure orphan → should die

    await sweepStreamDemo(env);

    const survivors = (await env.DB.prepare("SELECT id FROM owners WHERE display_name LIKE 'stream-%'").all()).results as Array<{ id: number }>;
    const ids = survivors.map((r) => r.id);
    expect(ids).toContain(promoted);
    expect(ids).toContain(walleted);
    expect(ids).not.toContain(undefined);
    // and the throwaway is gone
    expect(survivors.length).toBe(2);
  });

  it("is idempotent + safe on an empty stream (no throw, deletes nothing)", async () => {
    const res = await sweepStreamDemo(env);
    expect(res.owners).toBe(0);
    expect(res.couples).toBe(0);
  });
});
