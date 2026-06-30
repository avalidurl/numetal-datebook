/**
 * LlamaPay Payments Gateway — the HUMAN payment path for The Window (REDACTED-ID).
 *
 * A human reaches the public board with no founder key, reserves a slot, and pays $50 via a LlamaPay
 * HOSTED CHECKOUT (Coinbase-Commerce-compatible). The agent x402 path is untouched.
 *
 * Spec (LlamaPay's own docs — verified, do NOT deviate):
 *   - Base URL https://api.llamapay.io . Auth header VALUE is the key verbatim:
 *     `Authorization: llamapay_sk_…` (NO "Bearer"). Store the full string in LLAMAPAY_API_KEY.
 *   - CREATE CHARGE: POST /charges → { data: { hosted_url } }. We match payments by metadata.orderId,
 *     NOT by a charge id (the create response may not carry one we can rely on).
 *   - WEBHOOK: events "charge:pending" (on chain) + "charge:confirmed" (finalized) — treat EITHER as
 *     paid. Header `x-cc-webhook-signature` = HMAC-SHA256(LLAMAPAY_WEBHOOK_SECRET, RAW_BODY).hex.
 *     The payload carries NO tx hash / chain id / payer — only the LlamaPay payment id. Retries up to
 *     3 days → the handler MUST be idempotent + fast-200.
 */
import type { Env } from "../env";

export const LLAMAPAY_API = "https://api.llamapay.io";

export interface CreateChargeResult {
  ok: boolean;
  hostedUrl?: string;
  reason?: string;
}

/**
 * Create a fixed-price $50 USD hosted charge. `redirect_url` brings the payer back to the /window
 * page with ?order=<orderId> so it can start polling status; `cancel_url` returns to the board.
 * Authorization is the key VERBATIM (no "Bearer"). Fail-soft: returns {ok:false} with a reason, never throws.
 */
export async function createLlamapayCharge(
  env: Env,
  input: { orderId: string; amount: string; currency?: string; redirectUrl: string; cancelUrl: string },
  fetchImpl: typeof fetch = fetch,
): Promise<CreateChargeResult> {
  if (!env.LLAMAPAY_API_KEY) return { ok: false, reason: "llamapay not configured" };
  try {
    const res = await fetchImpl(`${LLAMAPAY_API}/charges`, {
      method: "POST",
      headers: {
        // VERBATIM key as the Authorization value — NOT "Bearer <key>".
        authorization: env.LLAMAPAY_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        pricing_type: "fixed_price",
        local_price: { amount: input.amount, currency: input.currency ?? "USD" },
        metadata: { orderId: input.orderId },
        redirect_url: input.redirectUrl,
        cancel_url: input.cancelUrl,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, reason: `llamapay ${res.status}: ${detail.slice(0, 300)}` };
    }
    const j = (await res.json().catch(() => ({}))) as { data?: { hosted_url?: string } };
    const hostedUrl = j.data?.hosted_url;
    if (!hostedUrl) return { ok: false, reason: "llamapay response missing data.hosted_url" };
    return { ok: true, hostedUrl };
  } catch (e) {
    return { ok: false, reason: `llamapay_error: ${(e as Error).message}` };
  }
}

const enc = (s: string) => new TextEncoder().encode(s);
const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Constant-time hex string comparison — same pattern as the Didit webhook (prevents timing attacks). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export interface LlamapayEvent {
  id: string; // event.id — the dedup key
  type: string; // charge:pending | charge:confirmed | ...
  data: {
    id: string; // LlamaPay payment id → "llamapay:<id>" payment ref
    metadata?: { orderId?: string } & Record<string, unknown>;
    hosted_url?: string;
    pricing?: unknown;
    pricing_type?: string;
  };
}

export interface VerifyWebhookResult {
  ok: boolean;
  event?: LlamapayEvent;
  reason?: string;
}

/**
 * Verify the LlamaPay webhook signature: header `x-cc-webhook-signature` (lowercase-lookup at the
 * caller) = HMAC-SHA256(LLAMAPAY_WEBHOOK_SECRET, RAW_REQUEST_BODY).hex. Constant-time. Parse only
 * AFTER the signature passes. Fail-closed: any error / missing secret → {ok:false} (the caller 401s).
 */
export async function verifyLlamapayWebhook(
  env: Env,
  rawBody: string,
  signature: string | undefined,
): Promise<VerifyWebhookResult> {
  if (!env.LLAMAPAY_WEBHOOK_SECRET) return { ok: false, reason: "llamapay webhook not configured" };
  if (!signature) return { ok: false, reason: "missing signature" };
  try {
    const key = await crypto.subtle.importKey("raw", enc(env.LLAMAPAY_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, enc(rawBody));
    if (!constantTimeEqual(toHex(mac), signature.trim().toLowerCase())) return { ok: false, reason: "bad signature" };
    // Parse only after the signature is good.
    const body = JSON.parse(rawBody) as { event?: LlamapayEvent };
    const event = body.event;
    if (!event || typeof event.id !== "string" || typeof event.type !== "string" || !event.data) {
      return { ok: false, reason: "malformed event payload" };
    }
    return { ok: true, event };
  } catch (e) {
    return { ok: false, reason: `llamapay_error: ${(e as Error).message}` };
  }
}
