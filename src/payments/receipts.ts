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
): Promise<{ ok: boolean; receiptId?: number; reason: string }> {
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
      payTo: ctx.payTo,
      amountUsdc: v.amountUsdc ?? String(dollars),
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

  return { ok: true, receiptId: rec?.id, reason: "settled" };
}
