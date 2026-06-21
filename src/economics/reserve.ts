/**
 * Buyback reserve accrual (Model C value signal). On each fulfilled x402 order we
 * accrue a % (BUYBACK_RESERVE_BPS) of revenue toward the NUMETAL buyback. This only
 * RECORDS the obligation — the on-chain buyback is founder-executed (agents never move
 * funds). Disclosure-clean by construction: reserve = a transparent cut of real revenue.
 */
import type { DB } from "../db/client";
import { buybackReserve } from "../db/schema";
import type { Env } from "../env";
import { getSetting } from "./budget";

export async function accrueBuyback(
  db: DB,
  env: Env,
  orderId: string,
  revenueUsdc: number,
): Promise<{ reserveUsdc: number; bps: number }> {
  const bps = Number(await getSetting(db, "buyback_reserve_bps", env.BUYBACK_RESERVE_BPS));
  const reserveUsdc = Math.round(revenueUsdc * bps) / 10000;
  await db
    .insert(buybackReserve)
    .values({
      orderId,
      revenueUsdc: revenueUsdc.toFixed(6),
      reserveUsdc: reserveUsdc.toFixed(6),
      bps,
      status: "accrued",
    })
    .run();
  return { reserveUsdc, bps };
}
