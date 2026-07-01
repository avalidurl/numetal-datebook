import { eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { db as makeDb, type DB } from "../src/db/client";
import { buybackReserve, owners, paymentReceipts, premiumOrders } from "../src/db/schema";
import { settleAndPersist } from "../src/payments/receipts";
import { SKUS, type PaymentProvider } from "../src/payments/x402";

const sku = SKUS.compatibility_report!;

const provider = (verified: boolean): PaymentProvider => ({
  network: "eip155:84532",
  facilitator: "mock",
  async verify() {
    return verified
      ? { verified: true, payer: "0xpayer", tx: "0xtx", amountUsdc: "5" }
      : { verified: false, raw: "bad" };
  },
});

let ownerId = 0;

async function seedOrder(db: DB, orderId: string) {
  await db
    .insert(premiumOrders)
    .values({
      orderId, ownerId, sku: sku.id, route: sku.route, priceUsd: sku.priceUsd,
      network: "eip155:84532", facilitator: "mock", status: "created",
    })
    .onConflictDoNothing()
    .run();
}

describe("x402 settle-then-persist", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM payment_receipts").run();
    await env.DB.prepare("DELETE FROM buyback_reserve").run();
    await env.DB.prepare("DELETE FROM premium_orders").run();
    await env.DB.prepare("DELETE FROM owners").run();
    const o = await makeDb(env.DB)
      .insert(owners)
      .values({ displayName: "test", tier: "agent_represented" })
      .returning({ id: owners.id })
      .get();
    ownerId = o.id;
  });

  it("fails closed when unverified — no receipt, order marked failed", async () => {
    const db = makeDb(env.DB);
    await seedOrder(db, "o_fail");
    const r = await settleAndPersist(db, env, provider(false), { orderId: "o_fail", sku, payTo: "0xpay" }, "BAD");
    expect(r.ok).toBe(false);
    expect(await db.select().from(paymentReceipts).where(eq(paymentReceipts.orderId, "o_fail")).get()).toBeUndefined();
    const ord = await db.select().from(premiumOrders).where(eq(premiumOrders.orderId, "o_fail")).get();
    expect(ord?.status).toBe("failed");
  });

  it("settles once and is idempotent on replay — no double receipt or double buyback", async () => {
    const db = makeDb(env.DB);
    await seedOrder(db, "o_ok");
    const r1 = await settleAndPersist(db, env, provider(true), { orderId: "o_ok", sku, payTo: "0xpay" }, "PAY");
    const r2 = await settleAndPersist(db, env, provider(true), { orderId: "o_ok", sku, payTo: "0xpay" }, "PAY");
    expect(r1.ok && r2.ok).toBe(true);
    expect(await db.select().from(paymentReceipts).where(eq(paymentReceipts.orderId, "o_ok")).all()).toHaveLength(1);
    expect(await db.select().from(buybackReserve).where(eq(buybackReserve.orderId, "o_ok")).all()).toHaveLength(1);
    const ord = await db.select().from(premiumOrders).where(eq(premiumOrders.orderId, "o_ok")).get();
    expect(ord?.status).toBe("fulfilled");
  });

  it("SEC#1/#3: a retry short-circuits BEFORE settle — verify() runs once, a fulfilled order is never flipped to failed", async () => {
    const db = makeDb(env.DB);
    await seedOrder(db, "o_idem");
    let verifyCalls = 0;
    // A shared counter across both provider instances so we can prove settle is attempted exactly once.
    const counting = (verified: boolean): PaymentProvider => ({
      network: "eip155:84532",
      facilitator: "mock",
      async verify() {
        verifyCalls++;
        return verified ? { verified: true, payer: "0xpayer", tx: "0xtx", amountUsdc: "5" } : { verified: false, raw: "authorization already spent" };
      },
    });
    const r1 = await settleAndPersist(db, env, counting(true), { orderId: "o_idem", sku, payTo: "0xpay" }, "PAY-N1");
    expect(r1.ok).toBe(true);
    // The retry re-signs a FRESH authorization (new nonce) — on mainnet provider.verify() would settle a
    // SECOND on-chain transfer. The idempotency guard must short-circuit BEFORE verify(): even a provider
    // that WOULD verify true is never called (no double-charge), and a false (already-spent) result must
    // NOT flip the fulfilled order to 'failed'.
    const r2 = await settleAndPersist(db, env, counting(false), { orderId: "o_idem", sku, payTo: "0xpay" }, "PAY-N2");
    expect(r2.ok).toBe(true); // short-circuited to the prior success
    expect(verifyCalls).toBe(1); // settle attempted exactly once — no double-charge
    const ord = await db.select().from(premiumOrders).where(eq(premiumOrders.orderId, "o_idem")).get();
    expect(ord?.status).toBe("fulfilled"); // NOT flipped to failed (#3)
    expect(await db.select().from(paymentReceipts).where(eq(paymentReceipts.orderId, "o_idem")).all()).toHaveLength(1);
  });
});
