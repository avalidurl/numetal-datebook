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
  nonce?: string; // EIP-3009 authorization nonce — the anti-replay key (red-team C4)
  network?: string;
  payTo?: string;
  raw?: string;
}

/**
 * Decode the signed x402 payment authorization — the SOURCE OF TRUTH for amount / recipient /
 * network / nonce. The facilitator only attests that the signature is valid; the resource server
 * MUST independently confirm the signed TERMS match what it requires (red-team C3/H8). Best-effort
 * across x402 payload shapes; returns null if it can't extract value + to (→ fail-closed).
 */
function parsePaymentHeader(header: string): { to?: string; value?: string; nonce?: string; network?: string } | null {
  let obj: Record<string, unknown> | null = null;
  for (const decode of [() => atob(header), () => header]) {
    try {
      obj = JSON.parse(decode()) as Record<string, unknown>;
      break;
    } catch {
      /* try the next form */
    }
  }
  if (!obj) return null;
  const payload = (obj.payload ?? {}) as Record<string, unknown>;
  const auth = (payload.authorization ?? obj.authorization ?? payload ?? {}) as Record<string, unknown>;
  const accepted = (obj.accepted ?? {}) as Record<string, unknown>; // v2 payload carries the chosen requirement here
  const network = (obj.network ?? payload.network ?? accepted.network) as string | undefined;
  const to = auth.to as string | undefined;
  const value = auth.value != null ? String(auth.value) : undefined;
  const nonce = (auth.nonce ?? obj.nonce) as string | undefined;
  return { to, value, nonce, network };
}

export interface PaymentProvider {
  network: string;
  facilitator: string;
  verify(paymentHeader: string, sku: Sku, payTo: string): Promise<VerifiedPayment>;
}

// Public origin for the x402 `resource` field. The x402 PaymentRequirements `resource` MUST be a full
// URL (clients reject a bare path), so we build it from the configured public base + the SKU route.
const DEFAULT_API_BASE = "https://api.ishtar.numetal.xyz";
function apiBase(env: Env): string {
  return (env.PUBLIC_API_URL || DEFAULT_API_BASE).replace(/\/+$/, "");
}
// Window (s) a signed payment authorization stays valid — clients set validBefore = now + this. Required field.
export const X402_MAX_TIMEOUT_SECONDS = 300;
// x402 protocol version. The modern @x402 SDK + the CDP facilitator are v2 (CAIP-2 networks); a v2 client
// rejects a `x402Version:1` challenge with "no client registered for version 1".
export const X402_VERSION = 2;

/**
 * The canonical x402 v2 PaymentRequirements for a SKU — the SINGLE source of truth used BOTH in the 402 challenge
 * `accepts[]` (what the client signs against) AND in the CDP verify/settle `paymentRequirements` (what the
 * facilitator checks the payload against). They MUST agree. v2 shape (per @x402/core `PaymentRequirementsV2Schema`):
 * CAIP-2 `network` (the CDP facilitator accepts CAIP-2 only), the amount field is `amount` (v1 called it
 * `maxAmountRequired`), and `resource`/`description`/`mimeType` do NOT live here — `resource` is a top-level
 * ResourceInfo object on the challenge body instead.
 */
export function x402Requirements(env: Env, sku: Sku, payTo: string) {
  const cfg = modeCfg(env);
  const dollars = Number(sku.priceUsd.replace("$", ""));
  return {
    scheme: "exact",
    network: cfg.network, // CAIP-2 (eip155:8453 / :84532) — NetworkSchemaV2
    amount: String(Math.round(dollars * 1e6)), // USDC 6dp; v2 field name (v1: maxAmountRequired)
    asset: cfg.asset,
    payTo,
    maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
    extra: cfg.eip712, // EIP-712 domain {name, version} — required by the v2 exact-EVM client to sign EIP-3009
  };
}

/** x402 v2 top-level ResourceInfo (the resource the payment unlocks). `url` is a full URL (required). */
export function x402ResourceInfo(env: Env, sku: Sku) {
  return { url: `${apiBase(env)}${sku.route}`, description: `Ishtar ${sku.id}`, mimeType: "application/json" };
}

/**
 * x402 v2 wire header codec. v2 carries PaymentRequired/PaymentSignature/PaymentResponse as base64(JSON) in
 * HTTP headers (PAYMENT-REQUIRED ← challenge, PAYMENT-SIGNATURE → payment, PAYMENT-RESPONSE ← settlement),
 * matching @x402/core `safeBase64Encode` = btoa(utf8 bytes). The JSON body is only read by v1 clients.
 */
export function encodeX402Header(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 402 challenge (x402 v2 wire). v2 clients read PaymentRequired from the PAYMENT-REQUIRED header. */
export function x402Challenge(env: Env, sku: Sku, payTo: string, orderId: string): Response {
  const body = {
    x402Version: X402_VERSION,
    error: "payment required",
    resource: x402ResourceInfo(env, sku), // v2: ResourceInfo object at the top level, not inside accepts
    accepts: [x402Requirements(env, sku, payTo)],
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "x-order-id": orderId,
      "PAYMENT-REQUIRED": encodeX402Header(body), // v2 clients read here; body is v1-only fallback
    },
  });
}

// ── CDP (mainnet) auth: a per-request EdDSA Bearer JWT ─────────────────────────────────────────────
const jwtEnc = new TextEncoder();
const b64url = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));

/**
 * Mint a Coinbase CDP Bearer JWT (EdDSA / Ed25519) bound to ONE request (method+host+path), valid ~2 min.
 * A CDP "Secret API Key" is base64 of a 64-byte Ed25519 key ([32-byte seed][32-byte public]); we wrap the
 * seed in the fixed Ed25519 PKCS8 prefix and sign with Web Crypto (no Node deps; runs in the Worker).
 */
export async function cdpBearer(keyId: string, secretB64: string, method: string, host: string, path: string): Promise<string> {
  const raw = fromB64(secretB64);
  const seed = raw.length >= 32 ? raw.slice(0, 32) : raw; // Ed25519 private seed = first 32 bytes
  const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", typ: "JWT", kid: keyId, nonce: b64url(crypto.getRandomValues(new Uint8Array(16))) };
  const payload = { sub: keyId, iss: "cdp", aud: ["cdp_service"], nbf: now, exp: now + 120, uris: [`${method} ${host}${path}`] };
  const signingInput = `${b64url(jwtEnc.encode(JSON.stringify(header)))}.${b64url(jwtEnc.encode(JSON.stringify(payload)))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, jwtEnc.encode(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
}

/** Decode an X-PAYMENT header (base64-JSON or raw-JSON) to the full payment payload object. */
function decodePayment(header: string): Record<string, unknown> | null {
  for (const dec of [() => atob(header), () => header]) {
    try {
      return JSON.parse(dec()) as Record<string, unknown>;
    } catch {
      /* try the next form */
    }
  }
  return null;
}

interface ModeCfg {
  network: string;
  facilitator: string;
  asset: string;
  mainnet: boolean;
  // EIP-712 domain of the asset, required in PaymentRequirements.extra so the v2 exact-EVM client can build the
  // EIP-3009 typed-data signature. Base USDC mainnet: name "USD Coin", version "2" (verified on-chain + SDK registry).
  eip712: { name: string; version: string };
}
function modeCfg(env: Env): ModeCfg {
  if (env.X402_MODE === "mainnet")
    return { network: MAINNET_NETWORK, facilitator: CDP_FACILITATOR, asset: USDC_BASE_MAINNET, mainnet: true, eip712: { name: "USD Coin", version: "2" } };
  return { network: STAGING_NETWORK, facilitator: STAGING_FACILITATOR, asset: USDC_BASE_SEPOLIA, mainnet: false, eip712: { name: "USDC", version: "2" } };
}

/**
 * Facilitator-backed provider. Staging = Base-Sepolia via the keyless x402.org facilitator (/verify only —
 * testnet, no real money moves). Mainnet = Base via the CDP facilitator, JWT-authed, verify→SETTLE (real
 * USDC moves on settle). Either way verify() FAIL-CLOSED and the signed TERMS (amount/recipient/network) are
 * checked independently of the facilitator's word (red-team C3/C4/H8).
 */
export function makeX402Provider(env: Env): PaymentProvider {
  const cfg = modeCfg(env);
  return {
    network: cfg.network,
    facilitator: cfg.facilitator,
    async verify(paymentHeader: string, sku: Sku, payTo: string): Promise<VerifiedPayment> {
      try {
        // Independent term check FIRST — never trust the facilitator on amount/recipient/network.
        const terms = parsePaymentHeader(paymentHeader);
        if (!terms || !terms.value || !terms.to) return { verified: false, raw: "payment terms unreadable" };
        let value: bigint;
        try {
          value = BigInt(terms.value);
        } catch {
          return { verified: false, raw: "bad amount" };
        }
        const required = BigInt(Math.round(Number(sku.priceUsd.replace("$", "")) * 1e6)); // USDC 6dp
        if (value < required) return { verified: false, raw: "underpayment" };
        if (terms.to.toLowerCase() !== payTo.toLowerCase()) return { verified: false, raw: "payTo mismatch" };
        if (terms.network && terms.network !== cfg.network) return { verified: false, raw: "network mismatch" };
        const ok = (): VerifiedPayment => ({
          verified: true,
          nonce: terms.nonce,
          payTo: terms.to,
          network: cfg.network,
          amountUsdc: (Number(value) / 1e6).toFixed(6),
        });

        if (cfg.mainnet) {
          if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) return { verified: false, raw: "cdp keys missing" };
          const host = "api.cdp.coinbase.com";
          const base = "/platform/v2/x402";
          const paymentPayload = decodePayment(paymentHeader);
          if (!paymentPayload) return { verified: false, raw: "payment payload unreadable" };
          // Same canonical requirements the client signed against in the 402 challenge — must match or the
          // facilitator rejects on a payload↔requirements mismatch (CAIP-2 network, full-URL resource, timeout).
          const paymentRequirements = x402Requirements(env, sku, payTo);
          const body = JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements });
          // verify (signature/funds valid?)
          const vTok = await cdpBearer(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET, "POST", host, `${base}/verify`);
          const vr = await fetch(`${cfg.facilitator}/verify`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${vTok}` }, body });
          if (!vr.ok) return { verified: false, raw: `cdp verify ${vr.status}` };
          const vj = (await vr.json()) as { isValid?: boolean; invalidReason?: string; payer?: string };
          if (!vj.isValid) return { verified: false, raw: vj.invalidReason ?? "cdp rejected" };
          // settle (broadcast transferWithAuthorization — real USDC moves here)
          const sTok = await cdpBearer(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET, "POST", host, `${base}/settle`);
          const sr = await fetch(`${cfg.facilitator}/settle`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${sTok}` }, body });
          if (!sr.ok) return { verified: false, raw: `cdp settle ${sr.status}` };
          const sj = (await sr.json()) as { success?: boolean; errorReason?: string; transaction?: string; payer?: string };
          if (!sj.success) return { verified: false, raw: sj.errorReason ?? "cdp settle failed" };
          return { ...ok(), payer: sj.payer ?? terms.to, tx: sj.transaction };
        }

        // Staging: keyless x402.org facilitator, /verify only (testnet — no real settlement).
        const res = await fetch(`${cfg.facilitator}/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ payment: paymentHeader, network: cfg.network, payTo, resource: sku.route }),
        });
        if (!res.ok) return { verified: false, raw: `facilitator ${res.status}` };
        const j = (await res.json()) as VerifiedPayment & { isValid?: boolean };
        if (!(j.verified ?? j.isValid ?? false)) return { verified: false, raw: j.raw ?? "facilitator rejected" };
        return { ...j, ...ok() };
      } catch (err) {
        return { verified: false, raw: `verify_error: ${(err as Error).message}` };
      }
    },
  };
}
