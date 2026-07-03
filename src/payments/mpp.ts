/**
 * MPP (Machine Payments Protocol) — the Tempo Labs + Stripe HTTP-402 standard
 * (IETF draft-httpauth-payment-00 + draft-tempo-charge-00). Second payment rail
 * next to x402: ONE 402, disjoint headers — x402 rides PAYMENT-REQUIRED, MPP rides
 * `WWW-Authenticate: Payment …`; the paid retry arrives as `Authorization: Payment
 * <b64url credential>` and success carries a `Payment-Receipt` header.
 *
 * v1 scope (deliberate):
 *  - method "tempo", intent "charge", PUSH mode only (supportedModes:["push"]): the
 *    client broadcasts its own TIP-20 transfer on Tempo (chainId 4217) and hands us
 *    the tx hash; we verify the on-chain Transfer log against the challenge. We never
 *    deserialize or broadcast type-0x76 transactions (pull mode requires full RLP
 *    verification per draft-tempo-charge §7.2 — v2 work), and we hold no fee-payer
 *    key (no hot keys in the runtime).
 *  - Offered only on SKUs where payment == delivery unconditionally (agent_ask,
 *    chat_topup). SKUs with policy-refusal paths AFTER payment (featured: board may
 *    be full; gated intake) stay x402-only until the refund policy is decided —
 *    push-mode money moves before we can refuse.
 *  - Dark until MPP_ENABLED + MPP_SECRET_KEY are set (recipient defaults to PAY_TO).
 *
 * Challenge ids are HMAC-bound over `realm|method|intent|request|expires|digest|opaque`
 * (empty string for absent slots) with a per-challenge nonce inside `opaque`, so terms
 * can't be swapped and ids are stateless-verifiable yet unique. Single-use is enforced
 * at the route ledger on BOTH the challenge id and the settlement tx hash.
 */
import type { Env } from "../env";
import type { Sku, VerifiedPayment } from "./x402";

// USDC on Tempo mainnet (TIP-20; the token AgentCash-class wallets hold and the one the
// Base→Tempo bridge mints — verified on the live bridge 2026-07-03). Runtime-overridable.
export const TEMPO_USDC = "0x20c000000000000000000000b9537d11c60e8b50";
export const TEMPO_CHAIN_ID = 4217; // Tempo mainnet (testnet Moderato = 42431)
export const MPP_NETWORK = `eip155:${TEMPO_CHAIN_ID}`; // CAIP-2, for the settle ledger
const DEFAULT_TEMPO_RPC = "https://rpc.tempo.xyz";
// keccak("Transfer(address,address,uint256)") — TIP-20 emits the standard event.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

/** SKUs that offer the MPP rail (see the v1-scope note above). */
export const MPP_SKUS = new Set(["agent_ask", "chat_topup"]);

export function mppEnabled(env: Env): boolean {
  const on = env.MPP_ENABLED === "1" || env.MPP_ENABLED === "true";
  return on && !!env.MPP_SECRET_KEY && !!(env.MPP_RECIPIENT || env.PAY_TO);
}
export function mppRecipient(env: Env): string {
  return (env.MPP_RECIPIENT || env.PAY_TO || "").toLowerCase();
}
export function mppCurrency(env: Env): string {
  return (env.MPP_CURRENCY || TEMPO_USDC).toLowerCase();
}
function tempoRpc(env: Env): string {
  return env.TEMPO_RPC_URL || DEFAULT_TEMPO_RPC;
}
function mppRealm(env: Env): string {
  return new URL(env.PUBLIC_API_URL || "https://api.ishtar.numetal.xyz").host;
}

// ── b64url (no padding, RFC 4648 §5) over UTF-8 ────────────────────────────────────────────────
export function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function hmacB64url(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time string equality (HMAC id comparison — never early-exit on a prefix match). */
function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The HMAC binding input per draft-httpauth-payment: empty string for absent slots. */
function bindingInput(realm: string, method: string, intent: string, request: string, expires: string, digest: string, opaque: string): string {
  return [realm, method, intent, request, expires, digest, opaque].join("|");
}

export function atomicAmount(sku: Sku): string {
  return String(Math.round(Number(sku.priceUsd.replace("$", "")) * 1e6)); // 6-decimal TIP-20 units
}

/**
 * Build the `WWW-Authenticate: Payment …` challenge header value for a SKU.
 * `request`/`opaque` are b64url JCS JSON — objects below are built with keys already in
 * lexicographic order, which is JCS-canonical for these flat shapes.
 */
export async function buildMppChallengeHeader(env: Env, sku: Sku): Promise<string> {
  const realm = mppRealm(env);
  const request = b64urlEncode(
    JSON.stringify({
      amount: atomicAmount(sku),
      currency: mppCurrency(env),
      methodDetails: { chainId: TEMPO_CHAIN_ID, supportedModes: ["push"] },
      recipient: mppRecipient(env),
    }),
  );
  // Per-challenge nonce lives in opaque → the HMAC-bound id is unique per challenge.
  const opaque = b64urlEncode(JSON.stringify({ n: crypto.randomUUID(), s: sku.id }));
  const expires = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const id = await hmacB64url(env.MPP_SECRET_KEY!, bindingInput(realm, "tempo", "charge", request, expires, "", opaque));
  return `Payment id="${id}", realm="${realm}", method="tempo", intent="charge", expires="${expires}", opaque="${opaque}", request="${request}"`;
}

// ── Credential parsing + verification ──────────────────────────────────────────────────────────
export interface MppCredential {
  challenge: { id?: string; realm?: string; method?: string; intent?: string; request?: string; expires?: string; opaque?: string; digest?: string };
  payload: { type?: string; signature?: string; hash?: string };
  source?: string;
}

/** Extract the MPP credential from an `Authorization: Payment <b64url>` header. Null = not MPP. */
export function parseMppAuth(header: string | undefined): MppCredential | null {
  if (!header) return null;
  const m = header.match(/^Payment\s+([A-Za-z0-9_-]+)$/i);
  if (!m) return null;
  try {
    const cred = JSON.parse(b64urlDecode(m[1]!)) as MppCredential;
    if (!cred || typeof cred !== "object" || !cred.challenge || !cred.payload) return null;
    return cred;
  } catch {
    return null;
  }
}

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
}
async function fetchTempoReceipt(env: Env, hash: string): Promise<{ status?: string; logs?: RpcLog[] } | null> {
  const r = await fetch(tempoRpc(env), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }),
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { result?: { status?: string; logs?: RpcLog[] } | null };
  return j.result ?? null;
}
const topicAddr = (topic: string): string => ("0x" + topic.slice(-40)).toLowerCase();

/**
 * Verify an MPP push-mode credential end-to-end (challenge authenticity → terms → on-chain
 * Transfer log). Returns the same VerifiedPayment shape the x402 provider yields, so routes
 * share the settle/ledger/receipt machinery. `nonce` = the challenge id (single-use key);
 * callers must ALSO dedupe on `tx` (one on-chain transfer can only buy one artifact).
 */
export async function verifyMppPayment(env: Env, cred: MppCredential, sku: Sku): Promise<VerifiedPayment> {
  const ch = cred.challenge;
  if (ch.method !== "tempo" || ch.intent !== "charge") return { verified: false, raw: "method-unsupported" };
  if (!ch.id || !ch.request || ch.realm !== mppRealm(env)) return { verified: false, raw: "invalid-challenge" };

  const expectId = await hmacB64url(env.MPP_SECRET_KEY!, bindingInput(ch.realm, ch.method, ch.intent, ch.request, ch.expires ?? "", ch.digest ?? "", ch.opaque ?? ""));
  if (!ctEqual(expectId, ch.id)) return { verified: false, raw: "invalid-challenge" };
  if (ch.expires && Date.parse(ch.expires) < Date.now()) return { verified: false, raw: "payment-expired" };

  let req: { amount?: string; currency?: string; recipient?: string };
  try {
    req = JSON.parse(b64urlDecode(ch.request));
  } catch {
    return { verified: false, raw: "malformed-credential" };
  }
  // The bound request must state OUR terms for THIS SKU — an id forged over other terms
  // already failed the HMAC, so this guards against config drift between issue and verify.
  if (req.currency?.toLowerCase() !== mppCurrency(env)) return { verified: false, raw: "verification-failed: currency" };
  if (req.recipient?.toLowerCase() !== mppRecipient(env)) return { verified: false, raw: "verification-failed: recipient" };
  if (req.amount !== atomicAmount(sku)) return { verified: false, raw: "payment-insufficient" };

  if (cred.payload.type !== "hash") return { verified: false, raw: "method-unsupported: push mode only (supportedModes:[push])" };
  const hash = cred.payload.hash;
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return { verified: false, raw: "malformed-credential" };

  // The client just broadcast (~500ms finality) — poll briefly rather than failing the race.
  let receipt: Awaited<ReturnType<typeof fetchTempoReceipt>> = null;
  for (let i = 0; i < 4 && !receipt; i++) {
    receipt = await fetchTempoReceipt(env, hash).catch(() => null);
    if (!receipt && i < 3) await new Promise((r) => setTimeout(r, 700));
  }
  if (!receipt || receipt.status !== "0x1") return { verified: false, raw: "verification-failed: no successful receipt" };

  const want = BigInt(req.amount);
  const log = (receipt.logs ?? []).find(
    (l) =>
      l.address?.toLowerCase() === mppCurrency(env) &&
      l.topics?.[0] === TRANSFER_TOPIC &&
      l.topics.length >= 3 &&
      topicAddr(l.topics[2]!) === mppRecipient(env) &&
      BigInt(l.data) >= want,
  );
  if (!log) return { verified: false, raw: "verification-failed: transfer log does not satisfy the challenge" };

  const payer = topicAddr(log.topics[1]!);
  return { verified: true, payer, tx: hash.toLowerCase(), amountUsdc: (Number(req.amount) / 1e6).toFixed(2), nonce: ch.id };
}

/** Success receipt header value (`Payment-Receipt`) — MUST NOT be attached to error responses. */
export function mppReceiptHeader(env: Env, challengeId: string, tx: string, sku: Sku): string {
  return b64urlEncode(
    JSON.stringify({
      challengeId,
      method: "tempo",
      reference: tx,
      settlement: { amount: atomicAmount(sku), currency: mppCurrency(env) },
      status: "success",
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    }),
  );
}

/** MPP failure = 402 + FRESH challenge + RFC 9457 problem body (never a receipt). */
export async function mppProblem(env: Env, sku: Sku, code: string, detail: string): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/problem+json",
    "cache-control": "no-store",
  };
  if (mppEnabled(env)) headers["WWW-Authenticate"] = await buildMppChallengeHeader(env, sku);
  return new Response(
    JSON.stringify({ type: `https://paymentauth.org/problems/${code}`, title: "Payment Required", status: 402, detail }),
    { status: 402, headers },
  );
}
