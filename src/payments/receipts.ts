/**
 * Durable, idempotent settle-then-persist (audit high-fix: lost payments).
 * Order of operations: verify → PERSIST receipt (before delivering) → mark order
 * fulfilled → accrue buyback. UNIQUE(order_id) on receipts makes a double-settle a
 * no-op (no double credit, no double buyback accrual). Fail-closed: unverified → fail.
 */
import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { paymentReceipts, premiumOrders } from "../db/schema";
import type { Env } from "../env";
import { accrueBuyback } from "../economics/reserve";
import type { PaymentRails } from "./dual-rail";
import { settlementNetwork, verifyPushRailFailClosed } from "./dual-rail";
import type { PaymentProvider, Sku } from "./x402";

export interface OrderCtx {
  orderId: string;
  sku: Sku;
  payTo: string;
}

export async function settleAndPersist(
  db: DB,
  env: Env,
  provider: PaymentProvider,
  ctx: OrderCtx,
  payment: string | PaymentRails,
): Promise<{ ok: boolean; receiptId?: number; reason: string; payer?: string; fresh?: boolean; mppResponse?: Response }> {
  const rails: PaymentRails =
    typeof payment === "string"
      ? { paymentHeader: payment, mppCred: null, isMpp: false, hasPayment: true }
      : payment;
  // SEC-2026-07-01(#1,#3): idempotency MUST precede settle. provider.verify() performs the irreversible
  // on-chain CDP /settle on mainnet; a retried order carrying a FRESHLY-signed EIP-3009 authorization
  // (new nonce) would settle a SECOND transfer — and the post-settle receipt insert (onConflictDoNothing
  // on order_id) then silently no-ops, so the payer is double-charged with no incremental receipt/credit.
  // A retry whose authorization is already spent would instead flip an already-fulfilled order to
  // 'failed'. Both are closed by short-circuiting BEFORE any settle: if this order already has a settled
  // receipt, return the prior success and never re-verify. (Mirrors the featured live-status pre-check.)
  const prior = await db
    .select({ id: paymentReceipts.id, payer: paymentReceipts.payer })
    .from(paymentReceipts)
    .where(eq(paymentReceipts.orderId, ctx.orderId))
    .get();
  // Return the recorded payer on the idempotent path too — but flag it `fresh: false`. The orderId is
  // client-supplied and caller-independent, so this short-circuit fires for ANYONE who replays a member's
  // order key (no re-verify happens here). A replayed payer therefore must NOT authorize a sensitive read
  // (see the compatibility-report grounded gate, which only trusts a `fresh` payer).
  if (prior) return { ok: true, receiptId: prior.id, reason: "already settled", payer: prior.payer ?? undefined, fresh: false };

  const verified = await verifyPushRailFailClosed(env, ctx.sku, ctx.payTo, rails, provider);
  if ("mppResponse" in verified) return { ok: false, reason: "payment not verified", mppResponse: verified.mppResponse };
  const v = verified.v;
  if (!v.verified) {
    await db
      .update(premiumOrders)
      .set({ status: "failed", updatedAt: new Date().toISOString() })
      .where(eq(premiumOrders.orderId, ctx.orderId))
      .run();
    return { ok: false, reason: v.raw ?? "payment not verified" };
  }

  const dollars = Number(ctx.sku.priceUsd.replace("$", ""));
  const rec = await db
    .insert(paymentReceipts)
    .values({
      orderId: ctx.orderId,
      paymentProtocol: rails.isMpp ? "mpp" : "x402",
      network: settlementNetwork(rails.isMpp, provider),
      facilitator: rails.isMpp ? "tempo" : provider.facilitator,
      payer: v.payer,
      payTo: v.payTo ?? ctx.payTo,
      amountUsdc: v.amountUsdc ?? String(dollars),
      nonce: v.nonce,
      settlementTx: v.tx,
      facilitatorReceipt: v.raw,
      status: "settled",
    })
    .onConflictDoNothing()
    .returning({ id: paymentReceipts.id })
    .get();

  await db
    .update(premiumOrders)
    .set({ status: "fulfilled", updatedAt: new Date().toISOString() })
    .where(eq(premiumOrders.orderId, ctx.orderId))
    .run();

  // Accrue only on first settle (rec is undefined on idempotent replay).
  if (rec) await accrueBuyback(db, env, ctx.orderId, dollars);

  // fresh: this call actually verified the presented payment (mainnet: CDP verify+settle), so the payer
  // is the authenticated CURRENT caller — safe to authorize a sensitive read on.
  return { ok: true, receiptId: rec?.id, reason: "settled", payer: v.payer, fresh: true };
}
