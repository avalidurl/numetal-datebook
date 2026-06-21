/**
 * x402 payment adapter (PaymentProvider boundary). Staging = Base Sepolia + the
 * x402.org testnet facilitator; production flips to Base mainnet + CDP (redacted).
 * Protocol / network / facilitator are kept separate so a better facilitator can drop
 * in without touching Ishtar. verify() is FAIL-CLOSED: any error → not verified.
 */
import type { Env } from "../env";

export interface Sku {
  id: string;
  priceUsd: string; // "$5.00"
  route: string;
}

export const SKUS: Record<string, Sku> = {
  compatibility_report: { id: "compatibility_report", priceUsd: "$5.00", route: "/api/premium/compatibility-report" },
  date_brief: { id: "date_brief", priceUsd: "$10.00", route: "/api/premium/date-brief" },
  priority_cycle: { id: "priority_cycle", priceUsd: "$1.00", route: "/api/premium/priority-cycle" },
  chat_topup: { id: "chat_topup", priceUsd: "$1.00", route: "/api/chat/topup" },
};

// Staging defaults (testnet only, no key). eip155:84532 = Base Sepolia.
export const STAGING_NETWORK = "eip155:84532";
export const STAGING_FACILITATOR = "https://x402.org/facilitator";
// USDC on Base Sepolia.
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

// Mainnet (real USDC) — Coinbase CDP facilitator. eip155:8453 = Base mainnet.
export const MAINNET_NETWORK = "eip155:8453";
export const CDP_FACILITATOR = "https://api.cdp.coinbase.com/platform/v2/x402";
// Canonical USDC on Base mainnet.
export const USDC_BASE_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export interface VerifiedPayment {
  verified: boolean;
  payer?: string;
  tx?: string;
  amountUsdc?: string;
  raw?: string;
}

export interface PaymentProvider {
  network: string;
  facilitator: string;
  verify(paymentHeader: string, sku: Sku, payTo: string): Promise<VerifiedPayment>;
}

/** 402 challenge body (x402 wire). Returned when no X-PAYMENT header is present. */
export function x402Challenge(opts: { sku: Sku; network: string; payTo: string; orderId: string }): Response {
  const dollars = Number(opts.sku.priceUsd.replace("$", ""));
  const body = {
    x402Version: 1,
    error: "payment required",
    accepts: [
      {
        scheme: "exact",
        network: opts.network,
        maxAmountRequired: String(Math.round(dollars * 1e6)), // USDC 6dp
        resource: opts.sku.route,
        description: `Ishtar ${opts.sku.id}`,
        payTo: opts.payTo,
        asset: USDC_BASE_SEPOLIA,
        mimeType: "application/json",
        outputSchema: { orderId: opts.orderId },
      },
    ],
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

/** Real facilitator-backed provider. verify()=verify+settle through the facilitator. */
export function makeX402Provider(env: Env): PaymentProvider {
  const facilitator = STAGING_FACILITATOR;
  return {
    network: STAGING_NETWORK,
    facilitator,
    async verify(paymentHeader: string, sku: Sku, payTo: string): Promise<VerifiedPayment> {
      try {
        const res = await fetch(`${facilitator}/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ payment: paymentHeader, network: STAGING_NETWORK, payTo, resource: sku.route }),
        });
        if (!res.ok) return { verified: false, raw: `facilitator ${res.status}` };
        const j = (await res.json()) as VerifiedPayment & { isValid?: boolean };
        const verified = j.verified ?? j.isValid ?? false;
        return { ...j, verified };
      } catch (err) {
        return { verified: false, raw: `verify_error: ${(err as Error).message}` };
      }
    },
  };
}
