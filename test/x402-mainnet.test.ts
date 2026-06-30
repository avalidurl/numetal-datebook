import { describe, expect, it } from "vitest";
import { cdpBearer, makeX402Provider, MAINNET_NETWORK, STAGING_NETWORK, CDP_FACILITATOR, STAGING_FACILITATOR } from "../src/payments/x402";
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
