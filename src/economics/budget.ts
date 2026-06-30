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

/** Upsert a runtime setting (used for the cached $NUMETAL price snapshot, etc.). */
export async function setSetting(db: DB, key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date().toISOString() } })
    .run();
}

async function spend(db: DB, day: string, callerRef?: string, tier?: string): Promise<number> {
  const conds = [eq(inferenceCosts.day, day)];
  if (callerRef) conds.push(eq(inferenceCosts.callerRef, callerRef));
  if (tier) conds.push(eq(inferenceCosts.tier, tier));
  const r = await db
    .select({ s: sql<number>`coalesce(sum(${inferenceCosts.usd}), 0)` })
    .from(inferenceCosts)
    .where(and(...conds))
    .get();
  return r?.s ?? 0;
}

// The matchmaker's own calls (seed gambits, system embeds) are NOT agent-attributable, so
// they answer only to the GLOBAL cap, never the per-agent cap — otherwise one busy beat
// would trip the "agent" ceiling on "system" and stall venue-wide matchmaking.
const isSystem = (callerRef?: string): boolean => !callerRef || callerRef === "system";

/**
 * Throws BudgetExceeded if this call would run past a cap (fail-closed on spend).
 *  - t0 (cache): always free.
 *  - t1 (embed + guard): GLOBAL stays uncapped so safety classification never halts the whole
 *    venue, but each AGENT has a small daily t1 cap — closes the amplification/bypass where a
 *    single caller drives unbounded "free" inference (admission guard, embeds).
 *  - t2 (strong/paid): global + per-agent caps.
 */
export async function assertWithinBudget(
  db: DB,
  env: Env,
  opts: { tier: "t0" | "t1" | "t2"; callerRef?: string },
): Promise<void> {
  if (opts.tier === "t0") return;
  const day = utcDay();

  if (opts.tier === "t1") {
    if (isSystem(opts.callerRef)) return; // system t1 (beat embeds) — global-only, uncapped here
    const cap = Number(
      await getSetting(db, "per_agent_daily_t1_budget_usd", env.PER_AGENT_DAILY_T1_BUDGET_USD),
    );
    const spent = await spend(db, day, opts.callerRef, "t1");
    if (spent >= cap) throw new BudgetExceeded("agent", spent, cap);
    return;
  }

  // t2: global cap first, then per-agent (system is exempt from the per-agent cap).
  const globalCap = Number(await getSetting(db, "daily_budget_usd", env.DAILY_BUDGET_USD));
  const globalSpent = await spend(db, day);
  if (globalSpent >= globalCap) throw new BudgetExceeded("global", globalSpent, globalCap);

  if (!isSystem(opts.callerRef)) {
    const agentCap = Number(
      await getSetting(db, "per_agent_daily_budget_usd", env.PER_AGENT_DAILY_BUDGET_USD),
    );
    const agentSpent = await spend(db, day, opts.callerRef);
    if (agentSpent >= agentCap) throw new BudgetExceeded("agent", agentSpent, agentCap);
  }
}
