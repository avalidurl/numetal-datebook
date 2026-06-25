/**
 * $NUMETAL perk + free-allowance resolver — READ-ONLY (audit/rule: agents never move funds; perks are
 * never a communication or safety wall). Reads the ERC-20 balance on Base and the current USD price,
 * and maps the USD value held to a free-message allowance and a venue-perk band. Best-effort: any
 * failure → 0 USD held → no free messages (never blocks, never throws to the caller).
 */
import { createPublicClient, http, erc20Abi, getAddress } from "viem";
import { base } from "viem/chains";

// $NUMETAL on Base (Doppler) — verified on-chain 2026-06-21: name/symbol NUMETAL, 18 decimals.
const NUMETAL_CA = "0x57EDb7FC54ADa9Ef4E113DC05A168449e63cFbA3" as const;
const DEFAULT_RPC = "https://mainnet.base.org";
// DexScreener pair for $NUMETAL on Base (the chart pair surfaced on the site) → live USD price.
const DEFAULT_PAIR = "0xf0ba727d596861455b31d6e444ed3ee41c77709a27f7d787ccf609f6c34dbbd8";

export type PerkLevel = "none" | "badge" | "priority" | "discount" | "founder";

// USD-denominated free-message model (decided 2026-06-25). Rationale: the old thresholds were raw
// token amounts (the top tier wanted 10,000,000,000 tokens ≈ 10% of supply — unattainable; a thin,
// volatile float makes any token-amount tier either absurd or trivially sybil-able). USD-pegging fixes
// both: the floor to earn ANY free messages is $30 of $NUMETAL, and every additional $30 held DOUBLES
// the daily allowance — 5/day at $30 → 10 @ $60 → 20 @ $90 → 40 @ $120 → 80 @ $150 → … — bounded by
// FREE_MAX so a whale can't open an unbounded free-inference tap. All three are runtime knobs.
export const FREE_STEP_USD = 30;
export const FREE_BASE = 5;
export const FREE_MAX = 1280; // clean doubling through ~$270 (5·2^8), then flat

/** Daily free messages for a wallet holding `usdHeld` USD of $NUMETAL. Pure; the public contract. */
export function freeQuotaForUsd(usdHeld: number, opts?: { step?: number; base?: number; max?: number }): number {
  const step = opts?.step ?? FREE_STEP_USD;
  const base = opts?.base ?? FREE_BASE;
  const max = opts?.max ?? FREE_MAX;
  if (!Number.isFinite(usdHeld) || usdHeld < step) return 0; // below the $30 floor → pay per message
  const steps = Math.floor(usdHeld / step); // 1 at $30, 2 at $60, …
  return Math.min(max, base * 2 ** (steps - 1));
}

/** Venue-perk band (priority cycles, report discounts) — also USD-pegged so it can't go absurd. */
export function perkForUsd(usdHeld: number): PerkLevel {
  if (usdHeld >= 900) return "founder";
  if (usdHeld >= 300) return "discount";
  if (usdHeld >= 90) return "priority";
  if (usdHeld >= 30) return "badge";
  return "none";
}

/** $NUMETAL price in USD via DexScreener. Best-effort: any failure → 0 (→ no free messages). */
export async function fetchNumetalPriceUsd(opts?: { pair?: string }): Promise<number> {
  try {
    const pair = opts?.pair ?? DEFAULT_PAIR;
    const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/base/${pair}`, {
      headers: { accept: "application/json" },
    });
    if (!r.ok) return 0;
    const j = (await r.json()) as { pair?: { priceUsd?: string }; pairs?: { priceUsd?: string }[] };
    const p = j.pair?.priceUsd ?? j.pairs?.[0]?.priceUsd;
    const n = p ? Number(p) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Read the on-chain $NUMETAL balance (wei). Throws on RPC failure (caller catches → 0 USD). */
async function readBalanceWei(address: string, opts?: { rpcUrl?: string; contract?: string }): Promise<bigint> {
  const contract = opts?.contract ?? NUMETAL_CA;
  if (!contract.startsWith("0x") || contract.length !== 42) return 0n; // CA not configured → no perk
  const client = createPublicClient({ chain: base, transport: http(opts?.rpcUrl ?? DEFAULT_RPC) });
  return (await client.readContract({
    address: getAddress(contract),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [getAddress(address)],
  })) as bigint;
}

/** balance × price → USD held. Best-effort: any failure → { usdHeld: 0, … "none" }. */
export async function readNumetalUsd(
  address: string,
  opts?: { rpcUrl?: string; contract?: string; pair?: string },
): Promise<{ usdHeld: number; balance: string; perkLevel: PerkLevel }> {
  try {
    const [bal, price] = await Promise.all([readBalanceWei(address, opts), fetchNumetalPriceUsd({ pair: opts?.pair })]);
    const tokens = Number(bal / 10n ** 14n) / 1e4; // whole tokens to 4dp — avoids bigint→float overflow
    const usdHeld = tokens * price;
    return { usdHeld, balance: bal.toString(), perkLevel: perkForUsd(usdHeld) };
  } catch {
    return { usdHeld: 0, balance: "0", perkLevel: "none" };
  }
}

/** Venue-perk read (USD-pegged). Kept for venue-perk callers; free messages use `readNumetalUsd`. */
export async function readNumetalPerk(
  address: string,
  opts?: { rpcUrl?: string; contract?: string; pair?: string },
): Promise<{ perkLevel: PerkLevel; balance: string; usdHeld: number }> {
  const r = await readNumetalUsd(address, opts);
  return { perkLevel: r.perkLevel, balance: r.balance, usdHeld: r.usdHeld };
}
