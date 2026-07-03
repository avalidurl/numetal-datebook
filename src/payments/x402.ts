/**
 * x402 payment adapter (PaymentProvider boundary). Staging = Base Sepolia + the
 * x402.org testnet facilitator; production flips to Base mainnet + CDP (redacted).
 * Protocol / network / facilitator are kept separate so a better facilitator can drop
 * in without touching Ishtar. verify() is FAIL-CLOSED: any error → not verified.
 */
import type { Env } from "../env";
import { buildMppChallengeHeader, MPP_SKUS, mppEnabled } from "./mpp";

export interface Sku {
  id: string;
  priceUsd: string; // "$5.00"
  route: string;
}

export const SKUS: Record<string, Sku> = {
  compatibility_report: { id: "compatibility_report", priceUsd: "$5.00", route: "/api/premium/compatibility-report" },
  date_brief: { id: "date_brief", priceUsd: "$10.00", route: "/api/premium/date-brief" },
  priority_cycle: { id: "priority_cycle", priceUsd: "$1.00", route: "/api/premium/priority-cycle" },
  // Agent chat top-up: $2 buys 15 messages (rate is CHAT_CREDITS_PER_USD; see chat.ts). Priced above
  // the per-answer rate on purpose — humans get a generous free/held allowance; agents pay their way.
  chat_topup: { id: "chat_topup", priceUsd: "$2.00", route: "/api/chat/topup" },
  // Agent dating-doc submission (the heart-file). Agents pay $1 to file a doc onto the floor; humans
  // file via the $NUMETAL-held human floor instead. Bare POST → 402; pay → the doc is created.
  doc_submit: { id: "doc_submit", priceUsd: "$1.00", route: "/api/intake/heart-file" },
  // Agent-facing pay-per-answer (x402-native). Bare POST → 402; pay → one Ishtar answer. The endpoint
  // the CDP Bazaar indexes on first mainnet settle. Small per-call price so agents can buy single answers.
  agent_ask: { id: "agent_ask", priceUsd: "$0.10", route: "/api/chat/ask" },
  // The Window (REDACTED-ID): pay-to-be-seen public dating-doc slot, 24h, 10 live max.
  // priceUsd is the catalog/challenge default; the live price is a runtime settings knob
  // ('featured_price_usd'), read in the route so it changes without a redeploy.
  featured_slot: { id: "featured_slot", priceUsd: "$50.00", route: "/api/featured/post" },
  // Contact reveal (the human-introduction unlock). EACH side pays this once to see the other's
  // contact — symmetric, so neither contact is shown until that side has paid for its own reveal.
  // Gated downstream of the 18+/ID check + mutual consent, so it never fires until reveals go live.
  reveal_unlock: { id: "reveal_unlock", priceUsd: "$20.00", route: "/api/escalations/reveal" },
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
export function parsePaymentHeader(header: string): { to?: string; value?: string; nonce?: string; network?: string } | null {
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
  // SEC-2026-07-01 (fuzz finding): coerce to string|undefined. A payload with a NON-string field (e.g.
  // {"authorization":{"to":2}}) otherwise returned `to` as a number, breaking the {to?:string} contract
  // and later throwing on terms.to.toLowerCase() (contained by verify's try/catch, but fragile). A
  // non-string to/network/nonce is invalid → undefined → verify fails closed on its !terms.to guard.
  const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const network = asStr(obj.network ?? payload.network ?? accepted.network);
  const to = asStr(auth.to);
  const value = auth.value != null ? String(auth.value) : undefined; // amount may be numeric in some payloads → String()
  const nonce = asStr(auth.nonce ?? obj.nonce);
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

/**
 * CDP Bazaar discovery extension (x402 v2 `extensions.bazaar`). CDP indexes a resource ONLY when it
 * settles a payment whose requirements DECLARE this metadata (settling alone is not enough — docs.cdp
 * .coinbase.com/x402/bazaar). `info.input` must pass strict JSON-Schema validation against
 * `schema.properties.input`, or CDP's EXTENSION-RESPONSES header on settle reads `rejected`. Only the
 * agent_ask surface is declared (the public, invocable pay-per-answer endpoint); other SKUs stay
 * undeclared → not cataloged, by design.
 */
export function x402BazaarExtension(sku: Sku): { bazaar: unknown } | null {
  if (sku.id !== "agent_ask") return null;
  const input = {
    type: "http",
    method: "POST",
    bodyType: "json",
    body: { message: "How do I write a dating doc that gets good matches?" },
  };
  return {
    bazaar: {
      info: {
        input,
        output: {
          type: "json",
          example: { ok: true, reply: "A candid, specific admission beats a résumé — try naming one small true thing you want a partner to know.", mode: "chat", paid: true },
        },
      },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          input: {
            type: "object",
            properties: {
              type: { type: "string" },
              method: { type: "string" },
              bodyType: { type: "string" },
              body: {
                type: "object",
                properties: { message: { type: "string", maxLength: 2000, description: "The dating/relationship question to ask Ishtar" } },
                required: ["message"],
              },
            },
            required: ["type", "method", "body"],
          },
          output: { type: "object" },
        },
        required: ["input"],
      },
    },
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

/**
 * 402 challenge — DUAL-RAIL wire. x402 v2 clients read PaymentRequired from the PAYMENT-REQUIRED
 * header; when MPP is enabled for the SKU the same 402 also carries a `WWW-Authenticate: Payment`
 * challenge (disjoint header spaces — each client parses only its own; live-proven pattern).
 * MPP requires `Cache-Control: no-store` on 402s; harmless for x402 clients, so set always.
 */
export async function x402Challenge(env: Env, sku: Sku, payTo: string, orderId: string): Promise<Response> {
  const ext = x402BazaarExtension(sku); // CDP Bazaar discovery metadata (agent_ask only)
  const body = {
    x402Version: X402_VERSION,
    error: "payment required",
    resource: x402ResourceInfo(env, sku), // v2: ResourceInfo object at the top level, not inside accepts
    accepts: [x402Requirements(env, sku, payTo)],
    ...(ext ? { extensions: ext } : {}), // top-level extensions (client echoes them into the payload)
  };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-order-id": orderId,
    "PAYMENT-REQUIRED": encodeX402Header(body), // v2 clients read here; body is v1-only fallback
  };
  if (mppEnabled(env) && MPP_SKUS.has(sku.id)) headers["WWW-Authenticate"] = await buildMppChallengeHeader(env, sku);
  return new Response(JSON.stringify(body, null, 2), { status: 402, headers });
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
          const paymentPayload = decodePayment(paymentHeader) as Record<string, unknown> | null;
          if (!paymentPayload) return { verified: false, raw: "payment payload unreadable" };
          // CDP Bazaar cataloging needs `paymentPayload.resource` at settle (docs: "the settle request
          // MUST contain paymentPayload.resource"). A generic x402 client may not set it, so inject the
          // full resource URL if absent — harmless to the payment, required for discovery.
          if (!paymentPayload.resource) paymentPayload.resource = x402ResourceInfo(env, sku).url;
          // Same canonical requirements the client signed against in the 402 challenge — must match or the
          // facilitator rejects on a payload↔requirements mismatch (CAIP-2 network, full-URL resource, timeout).
          // Carry the Bazaar discovery extension on the requirements so CDP's extractDiscoveryInfo() catalogs it.
          const ext = x402BazaarExtension(sku);
          const paymentRequirements = { ...x402Requirements(env, sku, payTo), ...(ext ? { extensions: ext } : {}) };
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
          // CDP reports Bazaar-metadata acceptance here: EXTENSION-RESPONSES = `processing` (accepted) or
          // `rejected`. Surface it in observability without failing the payment over a discovery hiccup.
          const extResp = sr.headers.get("EXTENSION-RESPONSES");
          if (extResp) console.log(JSON.stringify({ at: "x402.settle", sku: sku.id, extensionResponses: extResp }));
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
