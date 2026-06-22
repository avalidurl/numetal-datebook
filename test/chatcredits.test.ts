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

// Seed an account with a FRESH perk cache so refreshPerk() returns the given tier WITHOUT a
// network read (readNumetalPerk would otherwise hit a Base RPC — kept out of unit tests).
async function seed(db: DB, opts: { perk?: string; credits?: number } = {}) {
  await db
    .insert(chatAccounts)
    .values({
      address: ADDR,
      perkLevel: opts.perk ?? "none",
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

  it("fails to charge with no free quota and no credits (→ 402)", async () => {
    const db = makeDb(env.DB);
    await seed(db, { perk: "none", credits: 0 });
    const r = await chargeOne(db, env, ADDR);
    expect(r.ok).toBe(false);
  });

  it("debits one paid credit per message, then fails when empty", async () => {
    const db = makeDb(env.DB);
    await seed(db, { perk: "none", credits: 2 });
    const a = await chargeOne(db, env, ADDR);
    const b = await chargeOne(db, env, ADDR);
    const c = await chargeOne(db, env, ADDR);
    expect(a.ok && a.via).toBe("paid");
    expect(b.ok && b.via).toBe("paid");
    expect(c.ok).toBe(false);
    const acct = await db.select().from(chatAccounts).where(eq(chatAccounts.address, ADDR)).get();
    expect(acct?.credits).toBe(0);
  });

  it("spends the $NUMETAL free allowance before paid credits, bounded by perk quota", async () => {
    const db = makeDb(env.DB);
    // priority perk = 10 free/day; give 1 paid credit to prove free is used first.
    await seed(db, { perk: "priority", credits: 1 });
    const used: string[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await chargeOne(db, env, ADDR);
      if (r.ok) used.push(r.via);
    }
    // 10 free, then the 11th falls through to the single paid credit.
    expect(used.filter((v) => v === "free")).toHaveLength(10);
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
