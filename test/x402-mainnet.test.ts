import { describe, expect, it } from "vitest";
import {
  cdpBearer,
  makeX402Provider,
  MAINNET_NETWORK,
  STAGING_NETWORK,
  CDP_FACILITATOR,
  STAGING_FACILITATOR,
  x402Requirements,
  x402ResourceInfo,
  x402Challenge,
  X402_MAX_TIMEOUT_SECONDS,
  USDC_BASE_MAINNET,
  SKUS,
} from "../src/payments/x402";
import type { Env } from "../src/env";

// The CDP EdDSA JWT was verified live against api.cdp.coinbase.com (auth accepted) in the build; these
// lock the mode selection + the JWT structure so a regression can't silently break the mainnet path.
describe("x402 mode selection", () => {
  it("X402_MODE=mainnet → CDP facilitator + Base mainnet", () => {
    const p = makeX402Provider({ X402_MODE: "mainnet" } as unknown as Env);
    expect(p.network).toBe(MAINNET_NETWORK);
    expect(p.facilitator).toBe(CDP_FACILITATOR);
  });

  it("default/staging → x402.org facilitator + Base Sepolia", () => {
    const p = makeX402Provider({} as unknown as Env);
    expect(p.network).toBe(STAGING_NETWORK);
    expect(p.facilitator).toBe(STAGING_FACILITATOR);
  });
});

// Regression guard for the 2026-06-30 conformance fix: a standard x402 client (and the CDP facilitator)
// rejected our challenge because `resource` was a bare path and `maxTimeoutSeconds` was missing, and the
// challenge disagreed with the CDP-verify requirements. These lock the payable shape.
describe("x402 v2 challenge conformance (payable by the @x402 v2 client + CDP)", () => {
  const env = { X402_MODE: "mainnet", PAY_TO: "0x3eee81B5b4cf1983b7DB36cf042B5d06c04F33eE" } as unknown as Env;
  const sku = SKUS.chat_topup!;

  it("requirements (PaymentRequirementsV2): CAIP-2 network, `amount`, no inline resource", () => {
    const r = x402Requirements(env, sku, env.PAY_TO!) as Record<string, unknown>;
    expect(r.network).toBe(MAINNET_NETWORK); // eip155:8453 — CDP accepts CAIP-2 ONLY
    expect(r.network).toBe("eip155:8453");
    expect(r.amount).toBe("1000000"); // $1.00 at 6dp — v2 field `amount`, NOT maxAmountRequired
    expect(r.maxAmountRequired).toBeUndefined(); // v1 field must be absent under v2
    expect(r.resource).toBeUndefined(); // v2: resource is top-level, not inside the accept
    expect(r.asset).toBe(USDC_BASE_MAINNET);
    expect(r.payTo).toBe(env.PAY_TO);
    expect(r.maxTimeoutSeconds).toBe(X402_MAX_TIMEOUT_SECONDS);
    expect(r.scheme).toBe("exact");
    expect(r.extra).toEqual({ name: "USD Coin", version: "2" }); // EIP-712 domain so the v2 client can sign
  });

  it("challenge body: x402Version 2, top-level ResourceInfo.url, accepts[0] === requirements", async () => {
    const res = x402Challenge(env, sku, env.PAY_TO!, "chattopup:test");
    expect(res.status).toBe(402);
    const body = (await res.json()) as { x402Version: number; resource: { url: string }; accepts: unknown[] };
    expect(body.x402Version).toBe(2);
    expect(body.resource.url).toMatch(/^https:\/\/.+\/api\/chat\/topup$/); // full URL at the top level
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0]).toEqual(x402Requirements(env, sku, env.PAY_TO!));
  });

  it("PUBLIC_API_URL override builds the resource url (trailing slash trimmed)", () => {
    const r = x402ResourceInfo({ X402_MODE: "mainnet", PUBLIC_API_URL: "https://example.test/" } as unknown as Env, sku);
    expect(r.url).toBe("https://example.test/api/chat/topup");
  });
});

describe("CDP EdDSA bearer JWT", () => {
  it("mints a well-formed, request-bound EdDSA JWT", async () => {
    const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(64)))); // 64-byte CDP-shaped key
    const jwt = await cdpBearer("my-key-id", secret, "POST", "api.cdp.coinbase.com", "/platform/v2/x402/verify");
    const parts = jwt.split(".");
    expect(parts.length).toBe(3);
    const dec = (s: string) =>
      JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
    const h = dec(parts[0]!);
    const p = dec(parts[1]!);
    expect(h.alg).toBe("EdDSA");
    expect(h.kid).toBe("my-key-id");
    expect(p.iss).toBe("cdp");
    expect(p.aud).toEqual(["cdp_service"]);
    expect(p.uris).toEqual(["POST api.cdp.coinbase.com/platform/v2/x402/verify"]);
    expect(p.exp).toBeGreaterThan(p.nbf);
  });
});
