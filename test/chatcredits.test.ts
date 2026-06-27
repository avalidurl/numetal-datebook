import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db as makeDb, type DB } from "../src/db/client";
import { chatAccounts, chatTopups } from "../src/db/schema";
import {
  addCredits,
  chargeOne,
  consumeNonce,
  mintNonce,
  mintSession,
  resolveSession,
} from "../src/economics/chatcredits";

const ADDR = "0x1111111111111111111111111111111111111111";

// Seed an account with a FRESH perk cache so refreshPerk() returns the cached USD/tier WITHOUT a
// network read (readNumetalUsd would otherwise hit a Base RPC + DexScreener — kept out of unit tests).
// `usd` is the cached USD value of $NUMETAL held → free-message quota (floor $30, doubling per $30).
async function seed(db: DB, opts: { perk?: string; credits?: number; usd?: number } = {}) {
  await db
    .insert(chatAccounts)
    .values({
      address: ADDR,
      perkLevel: opts.perk ?? "none",
      usdHeld: opts.usd ?? 0,
      credits: opts.credits ?? 0,
      perkCheckedAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();
}

describe("talk-to-Ishtar credits", () => {
  beforeEach(async () => {
    for (const t of ["chat_accounts", "chat_sessions", "chat_topups", "chat_messages", "chat_nonces"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("sign-in nonce is single-use and rejects replay + unknown nonces", async () => {
    const db = makeDb(env.DB);
    const n = await mintNonce(db);
    expect(await consumeNonce(db, n)).toBe(true); // first use succeeds
    expect(await consumeNonce(db, n)).toBe(false); // replay rejected
    expect(await consumeNonce(db, "deadbeefdeadbeef")).toBe(false); // unknown rejected
    expect(await consumeNonce(db, "nothex!")).toBe(false); // malformed rejected
  });

  it("gives every wallet the 3/day free base, then 402 once it's spent (no credits)", async () => {
    const db = makeDb(env.DB);
    await seed(db, { usd: 0, credits: 0 }); // $0 held → 3 free/day base, no paid credits
    const rs = [];
    for (let i = 0; i < 4; i++) rs.push(await chargeOne(db, env, ADDR));
    expect(rs.slice(0, 3).every((r) => r.ok && r.via === "free")).toBe(true); // 3 free
    expect(rs[3]?.ok).toBe(false); // 4th → no free left, no credits → 402
  });

  it("debits paid credits only after the free base is used, then fails when empty", async () => {
    const db = makeDb(env.DB);
    await seed(db, { usd: 0, credits: 2 }); // 3 free + 2 paid
    const rs = [];
    for (let i = 0; i < 6; i++) rs.push(await chargeOne(db, env, ADDR));
    expect(rs.filter((r) => r.ok && r.via === "free")).toHaveLength(3);
    expect(rs.filter((r) => r.ok && r.via === "paid")).toHaveLength(2);
    expect(rs[5]?.ok).toBe(false);
    const acct = await db.select().from(chatAccounts).where(eq(chatAccounts.address, ADDR)).get();
    expect(acct?.credits).toBe(0);
  });

  it("holders get a bigger free allowance ($30 → 50/day), spent before paid credits", async () => {
    const db = makeDb(env.DB);
    // $30 held = 50 free/day; prove the holder quota applies and free is used before the paid credit.
    await seed(db, { usd: 30, credits: 1 });
    const used: string[] = [];
    for (let i = 0; i < 51; i++) {
      const r = await chargeOne(db, env, ADDR);
      if (r.ok) used.push(r.via);
    }
    // 50 free, then the 51st falls through to the single paid credit.
    expect(used.filter((v) => v === "free")).toHaveLength(50);
    expect(used.filter((v) => v === "paid")).toHaveLength(1);
    const acct = await db.select().from(chatAccounts).where(eq(chatAccounts.address, ADDR)).get();
    expect(acct?.credits).toBe(0);
  });

  it("top-up settle is idempotent — credits added once per orderId", async () => {
    const db = makeDb(env.DB);
    await seed(db, { perk: "none", credits: 0 });
    const settleOnce = async () => {
      const first = await db
        .insert(chatTopups)
        .values({ orderId: "t1", payer: ADDR, amountUsdc: "1", credits: 25, network: "eip155:84532" })
        .onConflictDoNothing()
        .returning({ id: chatTopups.id })
        .get();
      if (first) await addCredits(db, ADDR, 25);
      return !!first;
    };
    expect(await settleOnce()).toBe(true);
    expect(await settleOnce()).toBe(false); // replay is a no-op
    const acct = await db.select().from(chatAccounts).where(eq(chatAccounts.address, ADDR)).get();
    expect(acct?.credits).toBe(25);
    expect(await db.select().from(chatTopups).all()).toHaveLength(1);
  });

  it("sessions: mint → resolve roundtrips; bad/expired tokens resolve to null", async () => {
    const db = makeDb(env.DB);
    const { token } = await mintSession(db, ADDR, "signature");
    expect(await resolveSession(db, token)).toBe(ADDR);
    expect(await resolveSession(db, "ish_deadbeef")).toBeNull();
    expect(await resolveSession(db, "not-a-token")).toBeNull();
  });
});
