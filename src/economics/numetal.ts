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

// Thresholds in whole tokens (18 decimals). Tune in the ADR.
function perkFor(raw: bigint): PerkLevel {
  const tokens = raw / 10n ** 18n;
  if (tokens >= 1_000_000n) return "founder";
  if (tokens >= 100_000n) return "discount";
  if (tokens >= 10_000n) return "priority";
  if (tokens > 0n) return "badge";
  return "none";
}
