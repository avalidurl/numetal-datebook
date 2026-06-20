/**
 * Dollar budget governor (audit high-fix). Caps daily inference spend globally and
 * per-agent; fail-closed → callers convert BudgetExceeded into a 402 / cached answer.
 * Spend is read from the inference_costs ledger; limits are runtime-overridable via
 * the settings table (fallback to wrangler vars), so they change without a redeploy.
 */
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { inferenceCosts, settings } from "../db/schema";
import type { Env } from "../env";
import { utcDay } from "../env";

export type BudgetScope = "global" | "agent";

export class BudgetExceeded extends Error {
  constructor(public scope: BudgetScope, public spent: number, public cap: number) {
    super(`budget exceeded (${scope}): $${spent.toFixed(4)} >= $${cap.toFixed(4)}`);
    this.name = "BudgetExceeded";
  }
}

/** Runtime setting with env fallback. */
export async function getSetting(db: DB, key: string, fallback: string): Promise<string> {
  const row = await db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value ?? fallback;
}

async function spend(db: DB, day: string, callerRef?: string): Promise<number> {
  const where = callerRef
    ? and(eq(inferenceCosts.day, day), eq(inferenceCosts.callerRef, callerRef))
    : eq(inferenceCosts.day, day);
  const r = await db
    .select({ s: sql<number>`coalesce(sum(${inferenceCosts.usd}), 0)` })
    .from(inferenceCosts)
    .where(where)
    .get();
  return r?.s ?? 0;
}

/**
 * Throws BudgetExceeded if this call would run past a cap. Only the paid/strong tier
 * (t2) is gated; t0/t1 (cache + cheap moderation) stay free so safety always scales.
 */
export async function assertWithinBudget(
  db: DB,
  env: Env,
  opts: { tier: "t0" | "t1" | "t2"; callerRef?: string },
): Promise<void> {
  if (opts.tier !== "t2") return;
  const day = utcDay();
  const globalCap = Number(await getSetting(db, "daily_budget_usd", env.DAILY_BUDGET_USD));
  const globalSpent = await spend(db, day);
  if (globalSpent >= globalCap) throw new BudgetExceeded("global", globalSpent, globalCap);

  if (opts.callerRef) {
    const agentCap = Number(
      await getSetting(db, "per_agent_daily_budget_usd", env.PER_AGENT_DAILY_BUDGET_USD),
    );
    const agentSpent = await spend(db, day, opts.callerRef);
    if (agentSpent >= agentCap) throw new BudgetExceeded("agent", agentSpent, agentCap);
  }
}
