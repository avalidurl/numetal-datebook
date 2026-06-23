/**
 * $NUMETAL perk resolver — READ-ONLY (audit/rule: agents never move funds; perks are
 * never a communication or safety wall). Reads ERC-20 balance on Base via a public RPC
 * and maps it to a perk level. Best-effort: any failure → "none" (never blocks).
 */
import { createPublicClient, http, erc20Abi, getAddress } from "viem";
import { base } from "viem/chains";

// $NUMETAL on Base (Doppler) — verified on-chain 2026-06-21: name/symbol NUMETAL, 18 decimals.
const NUMETAL_CA = "0x57EDb7FC54ADa9Ef4E113DC05A168449e63cFbA3" as const;
const DEFAULT_RPC = "https://mainnet.base.org";

export type PerkLevel = "none" | "badge" | "priority" | "discount" | "founder";

export async function readNumetalPerk(
  address: string,
  opts?: { rpcUrl?: string; contract?: string },
): Promise<{ perkLevel: PerkLevel; balance: string }> {
  try {
    const contract = opts?.contract ?? NUMETAL_CA;
    if (!contract.startsWith("0x") || contract.length !== 42) {
      // Full CA not configured yet → no perk, but don't throw.
      return { perkLevel: "none", balance: "0" };
    }
    const client = createPublicClient({ chain: base, transport: http(opts?.rpcUrl ?? DEFAULT_RPC) });
    const bal = (await client.readContract({
      address: getAddress(contract),
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [getAddress(address)],
    })) as bigint;
    return { perkLevel: perkFor(bal), balance: bal.toString() };
  } catch {
    return { perkLevel: "none", balance: "0" };
  }
}

// Thresholds in WHOLE tokens (18 decimals). Re-pegged 2026-06-23 to be DDoS/sybil-safe.
// Context: $NUMETAL ≈ $2.45e-7 (mcap ~$24K, ~$25K on-chain liquidity, 100B supply). The OLD
// thresholds handed "founder" (200 free msgs/day) to anyone holding 1M tokens ≈ $0.24, and ANY
// dust got 3 free/day — a pure bankruptcy/DDoS vector. Now the cheapest path to ANY free message
// is the entry tier (100M ≈ 0.1% of supply), so a dust-sybil must lock real capital per wallet,
// which the thin float makes impossible to acquire at scale. Re-peg if price moves ~10x (and
// consider moving these to the `settings` table so it's a runtime knob, no redeploy).
function perkFor(raw: bigint): PerkLevel {
  const tokens = raw / 10n ** 18n;
  if (tokens >= 10_000_000_000n) return "founder"; // 10B  · 10%   of supply
  if (tokens >= 2_000_000_000n) return "discount"; // 2B   · 2%
  if (tokens >= 500_000_000n) return "priority";   // 500M · 0.5%
  if (tokens >= 100_000_000n) return "badge";      // 100M · 0.1%  (entry: first free messages)
  return "none";                                   // < 100M → no free allowance; pay via x402
}
