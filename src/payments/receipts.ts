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
  paymentHeader: string,
): Promise<{ ok: boolean; receiptId?: number; reason: string; payer?: string }> {
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
  // Return the recorded payer on the idempotent path too — downstream authorization (the
  // compatibility-report couple-membership gate) relies on the settled payer identity.
  if (prior) return { ok: true, receiptId: prior.id, reason: "already settled", payer: prior.payer ?? undefined };

  const v = await provider.verify(paymentHeader, ctx.sku, ctx.payTo);
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
      network: provider.network,
      facilitator: provider.facilitator,
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

  return { ok: true, receiptId: rec?.id, reason: "settled", payer: v.payer };
}
