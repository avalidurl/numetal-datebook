import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { SKUS, x402Requirements } from "../src/payments/x402";
import { creditsPerUsd } from "../src/economics/chatcredits";

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

describe("agent dating-doc submission fee ($1 x402)", () => {
  it("doc_submit is a $1.00 SKU on the intake route", () => {
    expect(SKUS.doc_submit).toBeDefined();
    expect(SKUS.doc_submit!.priceUsd).toBe("$1.00");
    expect(SKUS.doc_submit!.route).toBe("/api/intake/heart-file");
    const req = x402Requirements(env, SKUS.doc_submit!, "0x000000000000000000000000000000000000dEaD") as { amount?: string };
    expect(String(req.amount)).toBe("1000000"); // $1 at 6dp
  });

  it("a bare heart-file POST returns 402 (payment required) — no free doc when PAY_TO is set", async () => {
    // env has PAY_TO (x402 staging), so submission is metered: bare POST → x402 challenge.
    const r = await post("/api/intake/heart-file", { displayName: "x", heart: { a: 1 } });
    expect(r.status).toBe(402);
    // and it did NOT create anything (the paywall precedes row creation)
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    expect(body.ownerId).toBeUndefined();
  });
});

describe("chat top-up rate ($2 = 15 messages)", () => {
  it("chat_topup is $2.00 and the rate yields 15 messages", () => {
    expect(SKUS.chat_topup!.priceUsd).toBe("$2.00");
    const rate = creditsPerUsd(env); // 7.5 (from wrangler/test env default)
    const dollars = Number(SKUS.chat_topup!.priceUsd.replace("$", ""));
    expect(Math.round(rate * dollars)).toBe(15);
  });
});
