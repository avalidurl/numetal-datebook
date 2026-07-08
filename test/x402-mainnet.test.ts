import { describe, expect, it, vi } from "vitest";
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
  SOLANA_MAINNET_NETWORK,
  USDC_SOLANA_MAINNET,
  DEFAULT_PAY_TO_SOLANA,
  SKUS,
  parsePaymentTerms,
  solanaEnabled,
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

describe("x402 v2 challenge conformance (payable by the @x402 v2 client + CDP)", () => {
  const env = { X402_MODE: "mainnet", PAY_TO: "0x3eee81B5b4cf1983b7DB36cf042B5d06c04F33eE" } as unknown as Env;
  const sku = SKUS.chat_topup!;

  it("requirements (PaymentRequirementsV2): CAIP-2 network, `amount`, no inline resource", () => {
    const r = x402Requirements(env, sku, env.PAY_TO!) as Record<string, unknown>;
    expect(r.network).toBe(MAINNET_NETWORK);
    expect(r.amount).toBe("2000000");
    expect(r.maxAmountRequired).toBeUndefined();
    expect(r.resource).toBeUndefined();
    expect(r.asset).toBe(USDC_BASE_MAINNET);
    expect(r.payTo).toBe(env.PAY_TO);
    expect(r.maxTimeoutSeconds).toBe(X402_MAX_TIMEOUT_SECONDS);
    expect(r.scheme).toBe("exact");
    expect(r.extra).toEqual({ name: "USD Coin", version: "2" });
  });

  it("challenge body: x402Version 2, top-level ResourceInfo.url, accepts includes Base", async () => {
    const res = await x402Challenge(env, sku, "chattopup:test");
    expect(res.status).toBe(402);
    const body = (await res.json()) as { x402Version: number; resource: { url: string }; accepts: unknown[] };
    expect(body.x402Version).toBe(2);
    expect(body.resource.url).toMatch(/^https:\/\/.+\/api\/chat\/topup$/);
    expect(body.accepts.length).toBeGreaterThanOrEqual(1);
    expect(body.accepts[0]).toEqual(x402Requirements(env, sku, env.PAY_TO!));
  });

  it("multi-rail challenge includes Solana when X402_SOLANA_ENABLED", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/supported")) {
          return new Response(
            JSON.stringify({
              kinds: [{ scheme: "exact", network: SOLANA_MAINNET_NETWORK, extra: { feePayer: "FeePayer11111111111111111111111111111111" } }],
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );
    const multi = {
      X402_MODE: "mainnet",
      PAY_TO: env.PAY_TO,
      X402_SOLANA_ENABLED: "1",
      PAY_TO_SOLANA: DEFAULT_PAY_TO_SOLANA,
      CDP_API_KEY_ID: "test-key",
      CDP_API_KEY_SECRET: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(64)))),
    } as unknown as Env;
    expect(solanaEnabled(multi)).toBe(true);
    const res = await x402Challenge(multi, sku, "chattopup:sol");
    const body = (await res.json()) as { accepts: Array<Record<string, unknown>> };
    expect(body.accepts).toHaveLength(2);
    expect(body.accepts[1]?.network).toBe(SOLANA_MAINNET_NETWORK);
    expect(body.accepts[1]?.asset).toBe(USDC_SOLANA_MAINNET);
    expect(body.accepts[1]?.payTo).toBe(DEFAULT_PAY_TO_SOLANA);
    expect((body.accepts[1]?.extra as { feePayer?: string })?.feePayer).toBe("FeePayer11111111111111111111111111111111");
    vi.unstubAllGlobals();
  });

  it("PUBLIC_API_URL override builds the resource url (trailing slash trimmed)", () => {
    const r = x402ResourceInfo({ X402_MODE: "mainnet", PUBLIC_API_URL: "https://example.test/" } as unknown as Env, sku);
    expect(r.url).toBe("https://example.test/api/chat/topup");
  });
});

describe("parsePaymentTerms — SVM vs EVM", () => {
  it("EVM payload → rail evm with authorization fields", () => {
    const header = btoa(
      JSON.stringify({
        network: MAINNET_NETWORK,
        payload: { authorization: { to: "0xabc", value: "1000000", nonce: "0x1" } },
      }),
    );
    const t = parsePaymentTerms(header);
    expect(t?.rail).toBe("evm");
    expect(t?.to).toBe("0xabc");
    expect(t?.nonce).toBe("0x1");
  });

  it("SVM payload → rail svm from accepted.payTo (not EIP-3009)", () => {
    const header = btoa(
      JSON.stringify({
        accepted: {
          network: SOLANA_MAINNET_NETWORK,
          payTo: DEFAULT_PAY_TO_SOLANA,
          amount: "100000",
        },
        payload: { transaction: "AAAA" },
      }),
    );
    const t = parsePaymentTerms(header);
    expect(t?.rail).toBe("svm");
    expect(t?.to).toBe(DEFAULT_PAY_TO_SOLANA);
    expect(t?.value).toBe("100000");
  });
});

describe("CDP EdDSA bearer JWT", () => {
  it("mints a well-formed, request-bound EdDSA JWT", async () => {
    const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(64))));
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
