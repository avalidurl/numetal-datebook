/**
 * $NUMETAL perk + free-allowance resolver — READ-ONLY (audit/rule: agents never move funds; perks are
 * never a communication or safety wall). Reads the ERC-20 balance on Base and the current USD price,
 * and maps the USD value held to a free-message allowance and a venue-perk band. Best-effort: any
 * failure → 0 USD held → no free messages (never blocks, never throws to the caller).
 */
import { createPublicClient, http, erc20Abi, getAddress } from "viem";
import { base } from "viem/chains";
import type { DB } from "../db/client";
import type { Env } from "../env";
import { getSetting, setSetting } from "./budget";

// $NUMETAL on Base (Doppler) — verified on-chain 2026-06-21: name/symbol NUMETAL, 18 decimals.
const NUMETAL_CA = "0x57EDb7FC54ADa9Ef4E113DC05A168449e63cFbA3" as const;
const DEFAULT_RPC = "https://mainnet.base.org";
// DexScreener pair for $NUMETAL on Base (the chart pair surfaced on the site) → live USD price.
const DEFAULT_PAIR = "0xf0ba727d596861455b31d6e444ed3ee41c77709a27f7d787ccf609f6c34dbbd8";

export type PerkLevel = "none" | "badge" | "priority" | "discount" | "founder";

// USD-denominated free-message model (decided 2026-06-25, cost-grounded). Per-message cost on Workers AI
// is ~$0.00136 (llama-3.3-70b reply + 2 llama-guard passes; verified against CF's published pricing), so
// generous quotas are cheap — they're CEILINGS real humans rarely hit, and a venue-wide daily spend
// breaker (economics/budget.ts) backstops the worst case. The curve:
//   • FREE_FLOOR = 3/day for ANY signed-in 18+ wallet (even $0 held) — the funnel; ≤$0.12/mo if maxed.
//   • FREE_BASE  = 50/day at the $30 holding floor (≤~$2/mo if maxed) — the holder reward.
//   • doubling every +$30 (100 @ $60, 200 @ $90, 400 @ $120, …), bounded by
//   • FREE_MAX  = 500/day (~$120–150) so no single wallet can open an unbounded free-inference tap.
// USD-pegged (not raw token amounts) so a thin/volatile float can't make tiers absurd. All are knobs.
export const FREE_STEP_USD = 30;
export const FREE_FLOOR = 3; // everyone (any signed-in 18+ wallet), even $0 held
export const FREE_BASE = 50; // at the $30 holding floor
export const FREE_MAX = 500; // generous ceiling (~$120–150) that bounds our worst-case cost

/** Daily free messages for a wallet holding `usdHeld` USD of $NUMETAL. Pure; the public contract. */
export function freeQuotaForUsd(
  usdHeld: number,
  opts?: { step?: number; base?: number; max?: number; floor?: number },
): number {
  const step = opts?.step ?? FREE_STEP_USD;
  const base = opts?.base ?? FREE_BASE;
  const max = opts?.max ?? FREE_MAX;
  const floor = opts?.floor ?? FREE_FLOOR;
  if (!Number.isFinite(usdHeld) || usdHeld < step) return floor; // free base for everyone, no holding needed
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

// DeFiLlama swap (USDC → $NUMETAL on Base) — the human buy path to reach the $50 dating-doc floor.
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const NUMETAL_SWAP_URL =
  `https://swap.defillama.com/?chain=base&from=${USDC_BASE}&tab=swap&to=0x57edb7fc54ada9ef4e113dc05a168449e63cfba3`;

export interface BuyQuote {
  targetUsd: number; // the floor we're sizing for (default $50)
  priceUsd: number; // live $NUMETAL price (0 if the oracle had no confident read)
  usdHeld: number; // caller's current USD value held
  shortfallUsd: number; // how much more USD of $NUMETAL to reach targetUsd
  numetalNeeded: number; // token amount to buy ≈ shortfall / price (rounded up); 0 once at/above target
  usdcToSwap: number; // ≈ shortfallUsd — swap this many USDC for $NUMETAL
  buyUrl: string; // DeFiLlama swap, pre-filled with the USDC amount when possible
}

/** Compute the buy quote to reach `targetUsd` of $NUMETAL at the live price + current holdings. Pure. */
export function numetalBuyQuote(priceUsd: number, usdHeld: number, targetUsd = 50): BuyQuote {
  const held = Number.isFinite(usdHeld) && usdHeld > 0 ? usdHeld : 0;
  const shortfallUsd = Math.max(0, targetUsd - held);
  const usdcToSwap = Math.ceil(shortfallUsd * 100) / 100;
  const numetalNeeded = priceUsd > 0 && shortfallUsd > 0 ? Math.ceil(shortfallUsd / priceUsd) : 0;
  const buyUrl = usdcToSwap > 0 ? `${NUMETAL_SWAP_URL}&amount=${usdcToSwap}` : NUMETAL_SWAP_URL;
  return { targetUsd, priceUsd, usdHeld: held, shortfallUsd, numetalNeeded, usdcToSwap, buyUrl };
}

/** $NUMETAL price in USD via DexScreener (single source). Legacy/fallback — production reads go through
 *  getNumetalPriceUsd (cached + cross-checked + manipulation-smoothed). Best-effort: any failure → 0. */
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

// ── Production $NUMETAL/USD oracle ────────────────────────────────────────────────────────────────
// $NUMETAL's price IS its on-chain pool (no CEX lists it), so every quote is pool-derived and a thin
// Doppler pool is cheap to pump. A second aggregator does NOT fix that (both read the same pool), so the
// real defenses are: (1) a LIQUIDITY FLOOR (ignore junk-thin quotes), (2) a hourly SNAPSHOT cache in
// `settings` (the gate never reads raw spot), and (3) ONE-SIDED SMOOTHING — the stored price may fall
// immediately but may only RISE a little per refresh, so a momentary (or even hour-long) pump can't
// inflate a wallet's "USD held" to clear the $50 gate. Cross-checking DexScreener + GeckoTerminal still
// helps against one source being stale/down.
const PRICE_KEY = "numetal_price_usd";
const PRICE_TTL_MS = 60 * 60_000; // refresh the snapshot at most hourly
const PRICE_MAX_UP = 0.15; // stored price may rise ≤15% per refresh (anti pump-to-pass); falls freely
const MIN_LIQ_USD = 500; // a pool thinner than this gives a junk price → drop that quote
const GECKOTERMINAL = (ca: string) => `https://api.geckoterminal.com/api/v2/networks/base/tokens/${ca}`;

export interface PriceQuote {
  source: string;
  price: number;
  liquidityUsd?: number;
}

/** Pure: pick a USD price from cross-source quotes. Drops non-positive prices and sub-floor-liquidity
 *  pools, then takes the MEDIAN of what remains (a single bad pool can't swing it). 0 if nothing trusted. */
export function selectPriceUsd(quotes: PriceQuote[], opts?: { minLiquidityUsd?: number }): number {
  const floor = opts?.minLiquidityUsd ?? MIN_LIQ_USD;
  const ok = quotes
    .filter((q) => Number.isFinite(q.price) && q.price > 0 && (q.liquidityUsd == null || q.liquidityUsd >= floor))
    .map((q) => q.price)
    .sort((a, b) => a - b);
  if (ok.length === 0) return 0;
  const mid = Math.floor(ok.length / 2);
  return ok.length % 2 ? ok[mid]! : (ok[mid - 1]! + ok[mid]!) / 2;
}

/** Pure: one-sided smoothing. A new price may FALL immediately (conservative for a gate) but may RISE at
 *  most `maxUp` per refresh, so a momentary pool pump cannot quickly inflate held-USD to clear a gate. */
export function smoothPrice(prev: number, fresh: number, maxUp = PRICE_MAX_UP): number {
  if (!(fresh > 0)) return prev > 0 ? prev : 0; // all sources failed → keep last good (or 0 → fail closed)
  if (!(prev > 0)) return fresh; // first observation, nothing to smooth against
  return fresh <= prev ? fresh : Math.min(fresh, prev * (1 + maxUp));
}

/** Fetch raw cross-source quotes (DexScreener + GeckoTerminal). Never throws (allSettled). */
async function fetchPriceQuotes(opts?: { pair?: string; contract?: string }): Promise<PriceQuote[]> {
  const pair = opts?.pair ?? DEFAULT_PAIR;
  const ca = opts?.contract ?? NUMETAL_CA;
  const [ds, gt] = await Promise.allSettled([
    fetch(`https://api.dexscreener.com/latest/dex/pairs/base/${pair}`, { headers: { accept: "application/json" } }),
    fetch(GECKOTERMINAL(ca), { headers: { accept: "application/json" } }),
  ]);
  const quotes: PriceQuote[] = [];
  if (ds.status === "fulfilled" && ds.value.ok) {
    try {
      const j = (await ds.value.json()) as { pair?: Record<string, unknown>; pairs?: Record<string, unknown>[] };
      const pr = (j.pair ?? j.pairs?.[0]) as { priceUsd?: string; liquidity?: { usd?: number } } | undefined;
      const price = pr?.priceUsd ? Number(pr.priceUsd) : 0;
      const liq = pr?.liquidity?.usd != null ? Number(pr.liquidity.usd) : undefined;
      if (price > 0) quotes.push({ source: "dexscreener", price, liquidityUsd: liq });
    } catch {
      /* ignore a bad body */
    }
  }
  if (gt.status === "fulfilled" && gt.value.ok) {
    try {
      const j = (await gt.value.json()) as { data?: { attributes?: { price_usd?: string } } };
      const price = j.data?.attributes?.price_usd ? Number(j.data.attributes.price_usd) : 0;
      if (price > 0) quotes.push({ source: "geckoterminal", price });
    } catch {
      /* ignore a bad body */
    }
  }
  return quotes;
}

/**
 * Production $NUMETAL/USD price. Reads the hourly snapshot from `settings`; if stale, cross-checks
 * DexScreener + GeckoTerminal, drops thin-pool quotes (median of the rest), applies one-sided smoothing
 * vs the last snapshot, and writes it back. Best-effort + fail-closed: total source failure keeps the
 * last good snapshot; with no snapshot at all → 0 (so a gate denies rather than admitting on a junk price).
 */
export async function getNumetalPriceUsd(db: DB, env: Env): Promise<number> {
  const ttl = Number(env.NUMETAL_PRICE_TTL_MIN ?? "") * 60_000 || PRICE_TTL_MS;
  let prev = 0;
  try {
    const raw = await getSetting(db, PRICE_KEY, "");
    if (raw) {
      const snap = JSON.parse(raw) as { price?: number; ts?: number };
      prev = Number(snap.price) || 0;
      if (snap.ts && Date.now() - snap.ts < ttl && prev > 0) return prev; // fresh snapshot → use it
    }
  } catch {
    /* missing/corrupt snapshot → refresh below */
  }
  const quotes = await fetchPriceQuotes({ contract: env.NUMETAL_CA });
  const fresh = selectPriceUsd(quotes, { minLiquidityUsd: Number(env.NUMETAL_MIN_LIQ_USD ?? "") || MIN_LIQ_USD });
  const price = smoothPrice(prev, fresh);
  try {
    if (price > 0) await setSetting(db, PRICE_KEY, JSON.stringify({ price, ts: Date.now(), raw: fresh, sources: quotes.map((q) => q.source) }));
  } catch {
    /* snapshot write is best-effort */
  }
  return price;
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

/** balance × price → USD held. Pass `priceUsd` from getNumetalPriceUsd (the production oracle); without
 *  it, falls back to the single-source live fetch. Best-effort: any failure → { usdHeld: 0, … "none" }. */
export async function readNumetalUsd(
  address: string,
  opts?: { rpcUrl?: string; contract?: string; pair?: string; priceUsd?: number },
): Promise<{ usdHeld: number; balance: string; perkLevel: PerkLevel }> {
  try {
    const [bal, price] = await Promise.all([
      readBalanceWei(address, opts),
      opts?.priceUsd != null ? Promise.resolve(opts.priceUsd) : fetchNumetalPriceUsd({ pair: opts?.pair }),
    ]);
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
