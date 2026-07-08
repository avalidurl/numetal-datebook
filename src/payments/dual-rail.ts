/**
 * Shared x402 + MPP (push) dual-rail helpers. Pull-mode (chat_topup) stays in chat.ts — session
 * minting needs verifyMppPullPayment. Every other MPP SKU is push-mode.
 */
import type { Env } from "../env";
import type { MppCredential } from "./mpp";
import { MPP_NETWORK, mppEnabled, mppProblem, mppProblemCode, mppSkuActive, parseMppAuth, verifyMppPayment } from "./mpp";
import type { PaymentProvider, Sku, VerifiedPayment } from "./x402";

export interface PaymentRails {
  paymentHeader?: string;
  mppCred: MppCredential | null;
  isMpp: boolean;
  hasPayment: boolean;
}

export function readPaymentRails(
  env: Env,
  sku: Sku,
  headers: { paymentSignature?: string | null; xPayment?: string | null; authorization?: string | null },
): PaymentRails {
  const paymentHeader = headers.paymentSignature ?? headers.xPayment ?? undefined;
  const mppCred = mppEnabled(env) && mppSkuActive(env, sku) ? parseMppAuth(headers.authorization ?? undefined) : null;
  const isMpp = !paymentHeader && !!mppCred;
  return { paymentHeader, mppCred, isMpp, hasPayment: !!(paymentHeader || mppCred) };
}

export async function verifyPushRail(
  env: Env,
  sku: Sku,
  rails: PaymentRails,
  provider: PaymentProvider,
): Promise<VerifiedPayment> {
  if (rails.isMpp) return verifyMppPayment(env, rails.mppCred!, sku);
  return provider.verify(rails.paymentHeader!, sku);
}

/** Fail-closed verify. Returns mppResponse on MPP failure; otherwise returns v (caller re-challenges x402). */
export async function verifyPushRailFailClosed(
  env: Env,
  sku: Sku,
  rails: PaymentRails,
  provider: PaymentProvider,
): Promise<{ v: VerifiedPayment } | { mppResponse: Response }> {
  const v = await verifyPushRail(env, sku, rails, provider);
  if (!v.verified || !v.payer) {
    if (rails.isMpp) return { mppResponse: await mppProblem(env, sku, mppProblemCode(v.raw), "payment could not be verified") };
  }
  return { v };
}

export function settlementNetwork(isMpp: boolean, provider: PaymentProvider): string {
  return isMpp ? MPP_NETWORK : provider.network;
}

export function paymentRefPrefix(isMpp: boolean): "x402" | "mpp" {
  return isMpp ? "mpp" : "x402";
}
