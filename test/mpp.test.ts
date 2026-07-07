import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  atomicAmount,
  b64urlDecode,
  buildMppChallengeHeader,
  MPP_SKUS,
  mppEnabled,
  mppMode,
  mppProblem,
  mppProblemCode,
  mppReceiptHeader,
  parseMppAuth,
  verifyMppPayment,
  TEMPO_USDC,
  type MppCredential,
} from "../src/payments/mpp";
import { SKUS, x402Challenge } from "../src/payments/x402";
import type { Env } from "../src/env";

const RECIPIENT = "0x36de990133d36d7e3df9a820aa3ede5a2320de71";
const PAYER = "0x3eee81b5b4cf1983b7db36cf042b5d06c04f33ee";
const TX = "0x" + "ab".repeat(32);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (addr: string) => "0x" + addr.slice(2).padStart(64, "0");

const mppEnv = (over: Partial<Env> = {}): Env =>
  ({ ...env, PAY_TO: RECIPIENT, MPP_ENABLED: "1", MPP_SECRET_KEY: "test-secret", MPP_PULL_ENABLED: "1", ...over }) as Env;

/** Parse a WWW-Authenticate: Payment header into its params. */
function parseChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of header.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

/** A conforming credential echoing the given challenge params verbatim. */
function credFor(params: Record<string, string>, payload: MppCredential["payload"]): MppCredential {
  return {
    challenge: {
      id: params.id,
      realm: params.realm,
      method: params.method,
      intent: params.intent,
      expires: params.expires,
      opaque: params.opaque,
      request: params.request,
    },
    payload,
    source: `did:pkh:eip155:4217:${PAYER}`,
  };
}

/** Stub Tempo RPC: eth_getTransactionReceipt → a receipt with the given Transfer log. */
function stubRpc(receipt: unknown) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("rpc.tempo.xyz")) return Response.json({ jsonrpc: "2.0", id: 1, result: receipt });
    return orig(input as never, init as never);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}
const goodReceipt = (amount: bigint, to = RECIPIENT, token = TEMPO_USDC) => ({
  status: "0x1",
  logs: [{ address: token, topics: [TRANSFER_TOPIC, pad(PAYER), pad(to)], data: "0x" + amount.toString(16) }],
});

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("MPP — challenge issuance (dual-rail 402)", () => {
  it("builds a spec-shaped WWW-Authenticate challenge with push-only supportedModes", async () => {
    const e = mppEnv();
    const header = await buildMppChallengeHeader(e, SKUS.agent_ask!);
    expect(header.startsWith("Payment ")).toBe(true);
    const p = parseChallenge(header);
    expect(p.method).toBe("tempo");
    expect(p.intent).toBe("charge");
    expect(p.realm).toBe("api.ishtar.numetal.xyz");
    expect(p.id!.length).toBeGreaterThan(20);
    const req = JSON.parse(b64urlDecode(p.request!));
    expect(req).toEqual({
      amount: "100000", // $0.10 in 6-dec units
      currency: TEMPO_USDC,
      methodDetails: { chainId: 4217, supportedModes: ["push"] },
      recipient: RECIPIENT,
    });
    expect(Date.parse(p.expires!)).toBeGreaterThan(Date.now());
  });

  it("x402Challenge carries BOTH rails when MPP is enabled for the SKU — and no-store always", async () => {
    const e = mppEnv();
    const dual = await x402Challenge(e, SKUS.agent_ask!, RECIPIENT, "t");
    expect(dual.status).toBe(402);
    expect(dual.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(dual.headers.get("WWW-Authenticate")).toMatch(/^Payment /);
    expect(dual.headers.get("cache-control")).toBe("no-store");
    // topup mints a session → offers MPP in PULL mode (the signed tx proves wallet control)
    const topup = await x402Challenge(e, SKUS.chat_topup!, RECIPIENT, "t");
    expect(topup.headers.get("WWW-Authenticate")).toMatch(/^Payment /);
    const topupReq = JSON.parse(b64urlDecode(parseChallenge(topup.headers.get("WWW-Authenticate")!).request!));
    expect(topupReq.methodDetails.supportedModes).toEqual(["pull"]); // session-minting → pull only
    // non-MPP SKU → x402 only when MPP dark
    const solo = await x402Challenge({ ...e, MPP_ENABLED: undefined } as Env, SKUS.featured_slot!, RECIPIENT, "t");
    expect(solo.headers.get("WWW-Authenticate")).toBeNull();
    // featured + heart-file + doc_submit offer MPP push when enabled
    const doc = await x402Challenge(e, SKUS.doc_submit!, RECIPIENT, "t");
    expect(doc.headers.get("WWW-Authenticate")).toMatch(/^Payment /);
    const window = await x402Challenge(e, SKUS.featured_slot!, RECIPIENT, "t");
    expect(window.headers.get("WWW-Authenticate")).toMatch(/^Payment /);
    // MPP dark → x402 only even on MPP SKUs
    const dark = await x402Challenge({ ...e, MPP_ENABLED: undefined } as Env, SKUS.agent_ask!, RECIPIENT, "t");
    expect(dark.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("kill-switch: pull-mode topup is DARK without MPP_PULL_ENABLED (push/ask unaffected)", async () => {
    const dark = { ...mppEnv(), MPP_PULL_ENABLED: undefined } as Env; // MPP on, pull flag OFF
    expect((await x402Challenge(dark, SKUS.agent_ask!, RECIPIENT, "t")).headers.get("WWW-Authenticate")).toMatch(/^Payment /);
    expect((await x402Challenge(dark, SKUS.chat_topup!, RECIPIENT, "t")).headers.get("WWW-Authenticate")).toBeNull();
  });

  it("scope: all live paid SKUs offer MPP (topup pull, rest push)", () => {
    expect([...MPP_SKUS].sort()).toEqual([
      "agent_ask",
      "chat_topup",
      "compatibility_report",
      "doc_submit",
      "featured_slot",
      "reveal_unlock",
    ]);
    expect(mppMode(SKUS.agent_ask!)).toBe("push");
    expect(mppMode(SKUS.chat_topup!)).toBe("pull");
    expect(mppMode(SKUS.doc_submit!)).toBe("push");
    expect(mppMode(SKUS.featured_slot!)).toBe("push");
    expect(mppEnabled(mppEnv())).toBe(true);
    expect(mppEnabled(mppEnv({ MPP_SECRET_KEY: undefined }))).toBe(false);
  });
});

describe("MPP — credential verification (push mode)", () => {
  const issue = async (e: Env) => parseChallenge(await buildMppChallengeHeader(e, SKUS.agent_ask!));

  it("verifies a conforming hash credential against the on-chain Transfer log", async () => {
    const e = mppEnv();
    restore = stubRpc(goodReceipt(100000n));
    const v = await verifyMppPayment(e, credFor(await issue(e), { type: "hash", hash: TX }), SKUS.agent_ask!);
    expect(v.verified).toBe(true);
    expect(v.payer).toBe(PAYER);
    expect(v.tx).toBe(TX);
    expect(v.nonce!.length).toBeGreaterThan(20);
  });

  it("rejects a tampered challenge (terms swapped under the same id)", async () => {
    const e = mppEnv();
    const p = await issue(e);
    const cred = credFor(p, { type: "hash", hash: TX });
    // swap the bound request for a cheaper one — HMAC id no longer matches
    cred.challenge.request = cred.challenge.request!.replace(/^./, (c) => (c === "e" ? "f" : "e"));
    const v = await verifyMppPayment(e, cred, SKUS.agent_ask!);
    expect(v.verified).toBe(false);
    expect(String(v.raw)).toContain("invalid-challenge");
  });

  it("rejects pull-mode (transaction) credentials — push only in v1 (retryable verification-failed)", async () => {
    const e = mppEnv();
    const v = await verifyMppPayment(e, credFor(await issue(e), { type: "transaction", signature: "0x76aa" }), SKUS.agent_ask!);
    expect(v.verified).toBe(false);
    // wrong submission MODE (tempo/charge ARE supported) → 402-class verification-failed, not 400 method-unsupported
    expect(mppProblemCode(v.raw)).toBe("verification-failed");
  });

  it("wrong method/intent → 400-class method-unsupported", async () => {
    const e = mppEnv();
    const cred = credFor(await issue(e), { type: "hash", hash: TX });
    cred.challenge.method = "stripe";
    const v = await verifyMppPayment(e, cred, SKUS.agent_ask!);
    expect(v.verified).toBe(false);
    expect(mppProblemCode(v.raw)).toBe("method-unsupported");
  });

  it("fails closed (not a throw) on malformed on-chain log data", async () => {
    const e = mppEnv();
    restore = stubRpc({ status: "0x1", logs: [{ address: TEMPO_USDC, topics: [TRANSFER_TOPIC, pad(PAYER), pad(RECIPIENT)], data: "not-hex" }] });
    const v = await verifyMppPayment(e, credFor(await issue(e), { type: "hash", hash: TX }), SKUS.agent_ask!);
    expect(v.verified).toBe(false); // no unhandled throw → 500
  });

  it("rejects an on-chain transfer that underpays or targets the wrong recipient", async () => {
    const e = mppEnv();
    restore = stubRpc(goodReceipt(99999n)); // one unit short
    const short = await verifyMppPayment(e, credFor(await issue(e), { type: "hash", hash: TX }), SKUS.agent_ask!);
    expect(short.verified).toBe(false);
    restore();
    restore = stubRpc(goodReceipt(100000n, PAYER)); // paid, but not to us
    const wrongTo = await verifyMppPayment(e, credFor(await issue(e), { type: "hash", hash: TX }), SKUS.agent_ask!);
    expect(wrongTo.verified).toBe(false);
  });

  it("rejects a failed or missing receipt", async () => {
    const e = mppEnv();
    restore = stubRpc({ status: "0x0", logs: [] });
    const failed = await verifyMppPayment(e, credFor(await issue(e), { type: "hash", hash: TX }), SKUS.agent_ask!);
    expect(failed.verified).toBe(false);
    expect(String(failed.raw)).toContain("verification-failed");
  });

  it("rejects a challenge minted for a different SKU price", async () => {
    const e = mppEnv();
    restore = stubRpc(goodReceipt(100000n));
    // topup challenge ($2.00) redeemed against the ask SKU ($0.10) → amount mismatch
    const p = parseChallenge(await buildMppChallengeHeader(e, SKUS.chat_topup!));
    const v = await verifyMppPayment(e, credFor(p, { type: "hash", hash: TX }), SKUS.agent_ask!);
    expect(v.verified).toBe(false);
  });

  it("parseMppAuth accepts only the Payment scheme", () => {
    expect(parseMppAuth(undefined)).toBeNull();
    expect(parseMppAuth("Bearer abc")).toBeNull();
    expect(parseMppAuth("Payment not-base64url!!")).toBeNull();
    const ok = parseMppAuth(
      "Payment " +
        btoa(JSON.stringify({ challenge: { id: "x" }, payload: { type: "hash", hash: TX } }))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, ""),
    );
    expect(ok?.payload.type).toBe("hash");
  });
});

describe("MPP — route-level 402 on doc_submit", () => {
  const routeEnv = () => ({ ...env, PAY_TO: RECIPIENT, MPP_ENABLED: "1", MPP_SECRET_KEY: "route-secret" }) as Env;

  it("bare POST /api/intake/heart-file → 402 with WWW-Authenticate MPP + no-store", async () => {
    const ctx = createExecutionContext();
    const r = await worker.fetch(
      new Request("https://d/api/intake/heart-file", { method: "POST", headers: { "content-type": "application/json" }, cf: { country: "US" } }),
      routeEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(r.status).toBe(402);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(r.headers.get("WWW-Authenticate")).toMatch(/^Payment /);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("MPP — route-level single-use gate (/chat/ask)", () => {
  const routeEnv = () => ({ ...env, PAY_TO: RECIPIENT, MPP_ENABLED: "1", MPP_SECRET_KEY: "route-secret" }) as Env;
  const authHeader = (cred: MppCredential) =>
    "Payment " + btoa(JSON.stringify(cred)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const post = async (auth: string) => {
    const ctx = createExecutionContext();
    const r = await worker.fetch(
      new Request("https://d/api/chat/ask", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify({ message: "how do I write a good dating doc?" }),
        cf: { country: "US" },
      }),
      routeEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return r;
  };

  it("refuses a REPLAYED credential and a fresh challenge re-using a redeemed tx (insert-gate, not TOCTOU SELECT)", async () => {
    await env.DB.prepare("DELETE FROM chat_topups").run();
    const e = routeEnv();
    restore = stubRpc(goodReceipt(100000n));

    // First redemption: passes the gate (a ledger row is written BEFORE the AI-backed chaperone,
    // which is absent in the test runtime — so the request may 5xx afterwards; we only assert the
    // gate let it through and recorded the settle).
    const p1 = parseChallenge(await buildMppChallengeHeader(e, SKUS.agent_ask!));
    const first = await post(authHeader(credFor(p1, { type: "hash", hash: TX })));
    expect(first.status).not.toBe(402); // gate passed (not a payment refusal)
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM chat_topups WHERE settlement_tx = ?1").bind(TX).first<{ n: number }>();
    expect(row?.n).toBe(1); // exactly one settle recorded

    // Replay the SAME credential (same challenge id) → order_id conflict → 402 invalid-challenge.
    const replay = await post(authHeader(credFor(p1, { type: "hash", hash: TX })));
    expect(replay.status).toBe(402);
    expect((await replay.json() as { type: string }).type).toContain("invalid-challenge");

    // FRESH challenge re-using the already-redeemed tx hash → settlement_tx unique conflict → refused.
    const p2 = parseChallenge(await buildMppChallengeHeader(e, SKUS.agent_ask!));
    expect(p2.id).not.toBe(p1.id);
    const txReplay = await post(authHeader(credFor(p2, { type: "hash", hash: TX })));
    expect(txReplay.status).toBe(402);
    // still exactly one settle for this tx — no N-spend
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM chat_topups WHERE settlement_tx = ?1").bind(TX).first<{ n: number }>();
    expect(after?.n).toBe(1);
  });
});

describe("MPP — receipts and problems", () => {
  it("receipt header decodes to the spec shape", () => {
    const e = mppEnv();
    const r = JSON.parse(b64urlDecode(mppReceiptHeader(e, "chal-1", TX, SKUS.agent_ask!)));
    expect(r).toMatchObject({
      challengeId: "chal-1",
      method: "tempo",
      reference: TX,
      settlement: { amount: "100000", currency: TEMPO_USDC },
      status: "success",
    });
    expect(atomicAmount(SKUS.chat_topup!)).toBe("2000000");
  });

  it("402 problems are RFC 9457 + fresh challenge + no-store, never a receipt", async () => {
    const e = mppEnv();
    const res = await mppProblem(e, SKUS.agent_ask!, "invalid-challenge", "already used");
    expect(res.status).toBe(402);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("WWW-Authenticate")).toMatch(/^Payment /);
    expect(res.headers.get("Payment-Receipt")).toBeNull();
    const body = (await res.json()) as { type: string; status: number; title: string };
    expect(body.type).toBe("https://paymentauth.org/problems/invalid-challenge");
    expect(body.status).toBe(402);
    expect(body.title).toBe("Invalid Challenge"); // type-specific, not "Payment Required"
  });

  it("method-unsupported is a 400 with NO challenge (registry's lone non-402)", async () => {
    const e = mppEnv();
    const res = await mppProblem(e, SKUS.agent_ask!, "method-unsupported", "nope");
    expect(res.status).toBe(400);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    const body = (await res.json()) as { status: number };
    expect(body.status).toBe(400);
  });
});
