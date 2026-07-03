import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { SKUS, x402Requirements } from "../src/payments/x402";

async function post(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(
    new Request("https://d" + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      cf: { country: "US" },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return r;
}

describe("reveal_unlock SKU ($20 per-side reveal fee)", () => {
  it("is a $20.00 SKU pointed at the reveal route", () => {
    const sku = SKUS.reveal_unlock;
    expect(sku).toBeDefined();
    expect(sku!.priceUsd).toBe("$20.00");
    expect(sku!.route).toBe("/api/escalations/reveal");
  });

  it("prices at 20_000_000 USDC (6dp) in the x402 requirement", () => {
    const req = x402Requirements(env, SKUS.reveal_unlock!, "0x000000000000000000000000000000000000dEaD");
    // amount is the 6-decimal USDC integer string for $20
    const amount = (req as { amount?: string; maxAmountRequired?: string }).amount ?? (req as { maxAmountRequired?: string }).maxAmountRequired;
    expect(String(amount)).toBe("20000000");
  });

  it("does not disturb the reveal auth gate — still 400 without a privyToken, 503 before the paywall when Privy is unconfigured", async () => {
    // The $20 gate sits DOWNSTREAM of privy + revealReady, so the pre-existing auth shape is unchanged.
    expect((await post("/api/escalations/reveal", {})).status).toBe(400);
    const r = await post("/api/escalations/reveal", { privyToken: "x".repeat(20) });
    expect(r.status).toBe(503); // privy not configured in test env → never reaches the paywall, never leaks contact
    expect((await r.json() as { match?: unknown }).match).toBeUndefined();
  });

  it("OPTIONS preflight on the reveal route allows the x-payment header (CORS for the $20 unlock)", async () => {
    const ctx = createExecutionContext();
    const r = await worker.fetch(
      new Request("https://d/api/escalations/reveal", {
        method: "OPTIONS",
        headers: {
          origin: "https://ishtar.numetal.xyz",
          "access-control-request-method": "POST",
          "access-control-request-headers": "x-payment",
        },
        cf: { country: "US" },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const allow = (r.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allow).toContain("x-payment");
  });
});
