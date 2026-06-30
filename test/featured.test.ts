import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { claimAndPublishFeatured, listFeatured, purgeExpiredFeatured } from "../src/routes/featured";
import { db as makeDb } from "../src/db/client";
import type { PaymentProvider } from "../src/payments/x402";
import type { GuardFn } from "../src/chaperone";

// The HTTP route can't reach the live AI guard or the CDP facilitator in the test runtime, so —
// like admission.test / chatdoc.test — we exercise the core function with an INJECTED guard +
// payment provider. Production passes neither → the fail-closed Llama-Guard + live CDP provider.
const okGuard: GuardFn = async () => ({ safe: true, raw: "safe" });
const s12Guard: GuardFn = async () => ({ safe: false, raw: "unsafe\nS12", category: "S12" });
const s4Guard: GuardFn = async () => ({ safe: false, raw: "unsafe\nS4", category: "S4" });

// A controllable x402 provider — verify() returns a settled payment with a payer (chat_topup shape).
const payProvider = (payer = "0xPayer"): PaymentProvider => ({
  network: "eip155:84532",
  facilitator: "mock",
  async verify() {
    return { verified: true, payer, tx: "0xtx", amountUsdc: "50" };
  },
});
const badProvider: PaymentProvider = {
  network: "eip155:84532",
  facilitator: "mock",
  async verify() {
    return { verified: false, raw: "underpayment" };
  },
};

const PAY = "0xPAYMENTHEADER"; // opaque; the injected provider ignores its contents
const rnd = () => Math.random().toString(36).slice(2);
const input = (over: Partial<Parameters<typeof claimAndPublishFeatured>[2]> = {}) => ({
  authorKind: "human" as const,
  authorRef: "handle_" + rnd(),
  publicSummary: "loves arguing with citations; seeks the same",
  ref: "ref_" + rnd(),
  ...over,
});

describe("The Window (GOK-174) — paid public featured board", () => {
  beforeEach(async () => {
    for (const t of ["featured_posts", "settings", "buyback_reserve", "chat_accounts", "chaperone_decisions"])
      await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  it("atomic cap: exactly 10 live, the 11th → full (no over-admission)", async () => {
    const db = makeDb(env.DB);
    const outcomes = [];
    for (let i = 0; i < 11; i++) {
      outcomes.push(await claimAndPublishFeatured(db, env, input(), PAY, { provider: payProvider(), guard: okGuard }));
    }
    expect(outcomes.filter((o) => o.kind === "live")).toHaveLength(10);
    expect(outcomes.filter((o) => o.kind === "full")).toHaveLength(1);
    const cnt = await env.DB.prepare("SELECT count(*) c FROM featured_posts WHERE status='live'").first<{ c: number }>();
    expect(Number(cnt?.c)).toBe(10);
  });

  it("respects a runtime cap knob (featured_daily_cap)", async () => {
    const db = makeDb(env.DB);
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('featured_daily_cap','2')").run();
    const outcomes = [];
    for (let i = 0; i < 3; i++) outcomes.push(await claimAndPublishFeatured(db, env, input(), PAY, { provider: payProvider(), guard: okGuard }));
    expect(outcomes.filter((o) => o.kind === "live")).toHaveLength(2);
    expect(outcomes.some((o) => o.kind === "full")).toBe(true);
  });

  it("pay-then-cap race: a FULL board never charges (no payment attempted, claim precedes the 402)", async () => {
    const db = makeDb(env.DB);
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('featured_daily_cap','1')").run();
    // Fill the single slot.
    const first = await claimAndPublishFeatured(db, env, input(), PAY, { provider: payProvider(), guard: okGuard });
    expect(first.kind).toBe("live");

    // The next poster brings a VALID payment header — but the board is full, so the provider must
    // never be consulted (no charge on a full board). A throwing provider proves verify() isn't called.
    let verifyCalls = 0;
    const trap: PaymentProvider = {
      network: "eip155:84532",
      facilitator: "mock",
      async verify() {
        verifyCalls++;
        throw new Error("payment must NOT be attempted on a full board");
      },
    };
    const blocked = await claimAndPublishFeatured(db, env, input(), PAY, { provider: trap, guard: okGuard });
    expect(blocked.kind).toBe("full");
    expect(verifyCalls).toBe(0); // the money path was never entered

    const reserving = await env.DB.prepare("SELECT count(*) c FROM featured_posts WHERE status='reserving'").first<{ c: number }>();
    expect(Number(reserving?.c)).toBe(0); // no stray reservation left behind for the rejected poster
  });

  it("chaperone pre_publish hard-blocks an S12 (sexual) post — slot consumed, never published", async () => {
    const db = makeDb(env.DB);
    const r = await claimAndPublishFeatured(db, env, input(), PAY, { provider: payProvider(), guard: s12Guard });
    expect(r.kind).toBe("blocked");
    const live = await listFeatured(env);
    expect(live).toHaveLength(0); // an S12 post never reaches the public board
    const row = await env.DB.prepare("SELECT status FROM featured_posts").first<{ status: string }>();
    expect(row?.status).toBe("blocked");
  });

  it("chaperone pre_publish hard-blocks an S4 (minor) post", async () => {
    const db = makeDb(env.DB);
    const r = await claimAndPublishFeatured(db, env, input(), PAY, { provider: payProvider(), guard: s4Guard });
    expect(r.kind).toBe("blocked");
    expect(await listFeatured(env)).toHaveLength(0);
  });

  it("fails closed when payment is unverified — no live row, slot self-heals via the reservation TTL", async () => {
    const db = makeDb(env.DB);
    const r = await claimAndPublishFeatured(db, env, input(), PAY, { provider: badProvider, guard: okGuard });
    expect(r.kind).toBe("unpaid");
    expect(await listFeatured(env)).toHaveLength(0);
  });

  it("issues a 402 challenge AFTER the slot is claimed (no payment header → reservation held)", async () => {
    const db = makeDb(env.DB);
    const r = await claimAndPublishFeatured(db, env, input({ ref: "stable_ref_123456" }), undefined, { provider: payProvider(), guard: okGuard });
    expect(r.kind).toBe("challenge");
    const reserving = await env.DB.prepare("SELECT count(*) c FROM featured_posts WHERE status='reserving'").first<{ c: number }>();
    expect(Number(reserving?.c)).toBe(1); // the slot is held while the client fetches funds
  });

  it("is idempotent on the order ref — a replay does not double-charge nor double-accrue the buyback", async () => {
    const db = makeDb(env.DB);
    const ref = "idem_" + rnd();
    const r1 = await claimAndPublishFeatured(db, env, input({ ref }), PAY, { provider: payProvider(), guard: okGuard });
    const r2 = await claimAndPublishFeatured(db, env, input({ ref }), PAY, { provider: payProvider(), guard: okGuard });
    expect(r1.kind).toBe("live");
    expect(r2.kind).toBe("live");
    if (r2.kind === "live") expect(r2.already).toBe(true);
    expect(await env.DB.prepare("SELECT count(*) c FROM featured_posts").first<{ c: number }>().then((x) => Number(x?.c))).toBe(1);
    // one settle → exactly one buyback accrual
    expect(await env.DB.prepare("SELECT count(*) c FROM buyback_reserve").first<{ c: number }>().then((x) => Number(x?.c))).toBe(1);
  });

  it("public GET excludes expired rows (24h filter) and the cron purges them", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await env.DB.prepare("INSERT INTO featured_posts (author_kind, public_summary, order_id, status, expires_at) VALUES ('human','expired one','o_exp','live',?1)").bind(past).run();
    await env.DB.prepare("INSERT INTO featured_posts (author_kind, public_summary, order_id, status, expires_at) VALUES ('agent','live one','o_live','live',?1)").bind(future).run();

    const cards = await listFeatured(env);
    expect(cards).toHaveLength(1); // the expired row is filtered out of the public read
    expect(cards[0]!.summary).toBe("live one");

    const purged = await purgeExpiredFeatured(env);
    expect(purged.purged).toBe(1); // exactly the one expired live row flips to 'expired'
    const expiredRow = await env.DB.prepare("SELECT status FROM featured_posts WHERE order_id='o_exp'").first<{ status: string }>();
    expect(expiredRow?.status).toBe("expired");
    const liveRow = await env.DB.prepare("SELECT status FROM featured_posts WHERE order_id='o_live'").first<{ status: string }>();
    expect(liveRow?.status).toBe("live"); // an unexpired row is untouched
  });

  it("public GET returns ONLY the selective reveal — never the payer, order_id, or PII", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await env.DB
      .prepare(
        "INSERT INTO featured_posts (author_kind, author_ref, public_summary, reveal_fields, order_id, payer, status, expires_at) VALUES ('human','nightowl','seeks a co-conspirator',?1,'o_pii','0xSECRETWALLET','live',?2)",
      )
      .bind(JSON.stringify({ vibe: "deadpan", city: "remote" }), future)
      .run();
    const cards = await listFeatured(env);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("0xSECRETWALLET"); // payer wallet never surfaces
    expect(serialized).not.toContain("o_pii"); // order_id never surfaces
    expect(card).not.toHaveProperty("payer");
    expect(card).not.toHaveProperty("orderId");
    expect(card.summary).toBe("seeks a co-conspirator");
    expect(card.reveal).toEqual({ vibe: "deadpan", city: "remote" }); // only the chaperoned reveal
  });
});
