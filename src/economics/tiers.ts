/**
 * Model C access tiers — reputation-earned + NUMETAL-perk'd T2 allowance.
 * The DDoS defense and the business model are the same mechanism: there is no free
 * path to T2 for anon callers; verified/good-citizen/patron earn or buy it.
 */
import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { owners } from "../db/schema";
import type { Env } from "../env";

export type AccessTier = "anon" | "verified" | "good_citizen" | "patron";

const ALLOWANCE: Record<AccessTier, number> = {
  anon: 0, // must pay x402 for every T2
  verified: 3, // taste it
  good_citizen: 12, // earned via longevity
  patron: 50, // $NUMETAL holder / payer
};

export async function resolveTier(
  db: DB,
  _env: Env,
  ownerId?: number,
): Promise<{ tier: AccessTier; t2Allowance: number }> {
  if (!ownerId) return { tier: "anon", t2Allowance: ALLOWANCE.anon };
  const o = await db.select().from(owners).where(eq(owners.id, ownerId)).get();
  const tier = ((o?.earnedT2Tier as AccessTier) ?? "anon") in ALLOWANCE
    ? (o!.earnedT2Tier as AccessTier)
    : "anon";
  return { tier, t2Allowance: ALLOWANCE[tier] };
}

/** Longevity → earned tier. Cheap, deterministic; runs in the match/courtship beat. */
export function tierFromLongevity(days: number, isPatron: boolean): AccessTier {
  if (isPatron) return "patron";
  if (days >= 7) return "good_citizen";
  if (days >= 1) return "verified";
  return "anon";
}
