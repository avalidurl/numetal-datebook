import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, parseAbi } from "viem";
import * as Tempo from "viem/tempo";
import worker from "../src/index";
import {
  buildMppChallengeHeader,
  b64urlDecode,
  mppProblemCode,
  parseMppAuth,
  verifyMppPullPayment,
  verifyMppPayment,
  TEMPO_USDC,
  type MppCredential,
} from "../src/payments/mpp";
import { SKUS } from "../src/payments/x402";
import type { Env } from "../src/env";

// A funded test signer (well-known Hardhat key #1). Its address is deterministic.
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const SIGNER = Tempo.Account.fromSecp256k1(PK).address; // the wallet that will be RECOVERED
const RECIPIENT = "0x36de990133d36d7e3df9a820aa3ede5a2320de71";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (addr: string) => "0x" + addr.slice(2).padStart(64, "0");
const ABI = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function transferWithMemo(address to, uint256 amount, bytes32 memo)",
  "function approve(address spender, uint256 amount)",
]);

const mppEnv = (over: Partial<Env> = {}): Env =>
  ({ ...env, PAY_TO: RECIPIENT, MPP_ENABLED: "1", MPP_SECRET_KEY: "pull-secret", ...over }) as Env;

/** Parse a WWW-Authenticate: Payment header into its params. */
function parseChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of header.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}
const issue = async (e: Env, sku = SKUS.chat_topup!) => parseChallenge(await buildMppChallengeHeader(e, sku));

/** Build + sign a Tempo type-0x76 tx with the given calls (default: pay the topup price to us). */
async function signTx(
  calls: { to: string; data: `0x${string}`; value?: bigint }[],
  over: Record<string, unknown> = {},
): Promise<`0x${string}`> {
  const acct = Tempo.Account.fromSecp256k1(PK);
  return (await acct.signTransaction({
    chainId: 4217,
    calls,
    nonce: 0,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    gas: 100_000n,
    feeToken: TEMPO_USDC,
    ...over,
  } as never)) as `0x${string}`;
}
const transferCall = (to: string, amount: bigint, token = TEMPO_USDC) => ({
  to: token,
  data: encodeFunctionData({ abi: ABI, functionName: "transfer", args: [to as `0x${string}`, amount] }),
});

/** A pull credential echoing the challenge with a signed-transaction payload. */
function pullCred(params: Record<string, string>, signature: string): MppCredential {
  return {
    challenge: { id: params.id, realm: params.realm, method: params.method, intent: params.intent, expires: params.expires, opaque: params.opaque, request: params.request },
    payload: { type: "transaction", signature },
    source: `did:pkh:eip155:4217:${SIGNER}`,
  };
}

/**
 * Stub the Tempo RPC: eth_sendRawTransaction → the LOCALLY-computed tx hash of the raw tx we were
 * handed (so the server's receipt lookup keys on a stable hash), eth_getTransactionReceipt → the
 * given receipt. `broadcast` overrides the send response; `receiptFor` maps hash→receipt.
 */
function stubRpc(opts: {
  receipt: unknown | ((hash: string) => unknown);
  sendResult?: (rawTx: string, hash: string) => { result?: unknown; error?: { message?: string } };
}) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("rpc.tempo.xyz")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
      if (body.method === "eth_sendRawTransaction") {
        const rawTx = body.params[0] as string;
        const hash = txHashOf(rawTx);
        const r = opts.sendResult ? opts.sendResult(rawTx, hash) : { result: hash };
        return Response.json({ jsonrpc: "2.0", id: 1, ...r });
      }
      if (body.method === "eth_getTransactionReceipt") {
        const hash = body.params[0] as string;
        const rec = typeof opts.receipt === "function" ? (opts.receipt as (h: string) => unknown)(hash) : opts.receipt;
        return Response.json({ jsonrpc: "2.0", id: 1, result: rec });
      }
    }
    return orig(input as never, init as never);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

/** Compute the tx hash of a signed raw tx exactly as the server does (keccak of the full serialize). */
function txHashOf(rawTx: string): string {
  const tx = Tempo.Transaction.deserialize(rawTx as `0x${string}`) as { signature?: unknown };
  // We can't re-serialize without the sig envelope cheaply here in the stub for arbitrary txs, so
  // just keccak the raw bytes — the server keys receipts on ITS computed hash, and our confirmed
  // receipt is matched by Transfer log, not by this hash, so any stable value works for the stub.
  return keccak256(rawTx as `0x${string}`).toLowerCase();
}

const goodReceipt = (amount: bigint, to = RECIPIENT, from = SIGNER, token = TEMPO_USDC) => ({
  status: "0x1",
  logs: [{ address: token, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: "0x" + amount.toString(16) }],
});

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("MPP pull — challenge issuance", () => {
  it("topup advertises supportedModes ['pull']; ask advertises ['push']", async () => {
    const e = mppEnv();
    const topup = JSON.parse(b64urlDecode((await issue(e, SKUS.chat_topup!)).request!));
    expect(topup.methodDetails.supportedModes).toEqual(["pull"]);
    const ask = JSON.parse(b64urlDecode((await issue(e, SKUS.agent_ask!)).request!));
    expect(ask.methodDetails.supportedModes).toEqual(["push"]);
  });
});

describe("MPP pull — verifyMppPullPayment", () => {
  it("verifies a conforming pull credential and RECOVERS the payer from the signed tx", async () => {
    const e = mppEnv();
    restore = stubRpc({ receipt: goodReceipt(2_000_000n) });
    const raw = await signTx([transferCall(RECIPIENT, 2_000_000n)]);
    const v = await verifyMppPullPayment(e, pullCred(await issue(e), raw), SKUS.chat_topup!);
    expect(v.verified).toBe(true);
    expect(v.payer).toBe(SIGNER.toLowerCase()); // recovered from the signature, not claimed
    expect(v.amountUsdc).toBe("2.00");
    expect(v.nonce!.length).toBeGreaterThan(20);
    expect(v.tx).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("accepts an overpaying transferWithMemo call to us", async () => {
    const e = mppEnv();
    restore = stubRpc({ receipt: goodReceipt(2_500_000n) });
    const data = encodeFunctionData({ abi: ABI, functionName: "transferWithMemo", args: [RECIPIENT as `0x${string}`, 2_500_000n, ("0x" + "00".repeat(32)) as `0x${string}`] });
    const raw = await signTx([{ to: TEMPO_USDC, data }]);
    const v = await verifyMppPullPayment(e, pullCred(await issue(e), raw), SKUS.chat_topup!);
    expect(v.verified).toBe(true);
    expect(v.payer).toBe(SIGNER.toLowerCase());
  });

  it("REJECTS a wrong-type (hash) payload on a pull challenge → verification-failed", async () => {
    const e = mppEnv();
    const cred: MppCredential = { ...pullCred(await issue(e), "0x00"), payload: { type: "hash", hash: "0x" + "ab".repeat(32) } };
    const v = await verifyMppPullPayment(e, cred, SKUS.chat_topup!);
    expect(v.verified).toBe(false);
    expect(mppProblemCode(v.raw)).toBe("verification-failed");
  });

  it("REJECTS a tampered challenge HMAC (terms swapped under the same id)", async () => {
    const e = mppEnv();
    restore = stubRpc({ receipt: goodReceipt(2_000_000n) });
    const raw = await signTx([transferCall(RECIPIENT, 2_000_000n)]);
    const cred = pullCred(await issue(e), raw);
    cred.challenge.request = cred.challenge.request!.replace(/^./, (x) => (x === "e" ? "f" : "e"));
    const v = await verifyMppPullPayment(e, cred, SKUS.chat_topup!);
    expect(v.verified).toBe(false);
    expect(String(v.raw)).toContain("invalid-challenge");
  });

  it("REJECTS a batch that moves value elsewhere (a second transfer to a stranger)", async () => {
    const e = mppEnv();
    restore = stubRpc({ receipt: goodReceipt(2_000_000n) });
    const stranger = "0x000000000000000000000000000000000000beef";
    const raw = await signTx([transferCall(RECIPIENT, 2_000_000n), transferCall(stranger, 1n)]);
    const v = await verifyMppPullPayment(e, pullCred(await issue(e), raw), SKUS.chat_topup!);
    expect(v.verified).toBe(false); // only ONE qualifying call allowed
  });

  it("REJECTS an unexpected selector (approve) even to the currency token", async () => {
    const e = mppEnv();
    restore = stubRpc({ receipt: goodReceipt(2_000_000n) });
    const data = encodeFunctionData({ abi: ABI, functionName: "approve", args: [RECIPIENT as `0x${string}`, 2_000_000n] });
    const raw = await signTx([{ to: TEMPO_USDC, data }]);
    const v = await verifyMppPullPayment(e, pullCred(await issue(e), raw), SKUS.chat_topup!);
    expect(v.verified).toBe(false);
  });

  it("REJECTS a transfer to the WRONG recipient", async () => {
    const e = mppEnv();
    restore = stubRpc({ receipt: goodReceipt(2_000_000n, "0x000000000000000000000000000000000000beef") });
    const raw = await signTx([transferCall("0x000000000000000000000000000000000000beef", 2_000_000n)]);
    const v = await verifyMppPullPayment(e, pullCred(await issue(e), raw), SKUS.chat_topup!);
    expect(v.verified).toBe(false);
  });

  it("REJECTS an underpaying transfer (one unit short)", async () => {
    const e = mppEnv();
    restore = stubRpc({ receipt: goodReceipt(1_999_999n) });
    const raw = await signTx([transferCall(RECIPIENT, 1_999_999n)]);
    const v = await verifyMppPullPayment(e, pullCred(await issue(e), raw), SKUS.chat_topup!);
    expect(v.verified).toBe(false);
    expect(mppProblemCode(v.raw)).toBe("payment-insufficient");
  });

  it("REJECTS a REVERTED receipt (status 0x0) — broadcast is NOT the gate", async () => {
    const e = mppEnv();
    restore = stubRpc({ receipt: { status: "0x0", logs: [] } }); // send succeeds, receipt reverts
    const raw = await signTx([transferCall(RECIPIENT, 2_000_000n)]);
    const v = await verifyMppPullPayment(e, pullCred(await issue(e), raw), SKUS.chat_topup!);
    expect(v.verified).toBe(false);
  });

  it("REJECTS an UNCONFIRMED receipt (null) — no receipt, no session", async () => {
    const e = mppEnv();
    restore = stubRpc({ receipt: null });
    const raw = await signTx([transferCall(RECIPIENT, 2_000_000n)]);
    const v = await verifyMppPullPayment(e, pullCred(await issue(e), raw), SKUS.chat_topup!);
    expect(v.verified).toBe(false);
  });

  it("REJECTS when the confirmed Transfer log's from ≠ the recovered signer", async () => {
    const e = mppEnv();
    // Receipt shows a Transfer FROM a different address than the one that signed the tx.
    restore = stubRpc({ receipt: goodReceipt(2_000_000n, RECIPIENT, "0x000000000000000000000000000000000000dead") });
    const raw = await signTx([transferCall(RECIPIENT, 2_000_000n)]);
    const v = await verifyMppPullPayment(e, pullCred(await issue(e), raw), SKUS.chat_topup!);
    expect(v.verified).toBe(false);
  });

  it("still verifies on an 'already known' broadcast race (fetches the receipt by hash)", async () => {
    const e = mppEnv();
    restore = stubRpc({
      receipt: goodReceipt(2_000_000n),
      sendResult: () => ({ error: { message: "already known" } }),
    });
    const raw = await signTx([transferCall(RECIPIENT, 2_000_000n)]);
    const v = await verifyMppPullPayment(e, pullCred(await issue(e), raw), SKUS.chat_topup!);
    expect(v.verified).toBe(true); // benign race → verify by receipt, not fail
    expect(v.payer).toBe(SIGNER.toLowerCase());
  });

  it("fails closed (not a throw) on a garbage signed-tx hex", async () => {
    const e = mppEnv();
    const v = await verifyMppPullPayment(e, pullCred(await issue(e), "0xdeadbeef"), SKUS.chat_topup!);
    expect(v.verified).toBe(false); // no unhandled throw → 500
  });

  it("push verifier still REJECTS a pull (transaction) credential — modes don't cross", async () => {
    const e = mppEnv();
    const raw = await signTx([transferCall(RECIPIENT, 100_000n)]);
    const v = await verifyMppPayment(e, pullCred(await issue(e, SKUS.agent_ask!), raw), SKUS.agent_ask!);
    expect(v.verified).toBe(false);
  });
});

describe("MPP pull — route (/api/chat/topup)", () => {
  const routeEnv = () => ({ ...env, PAY_TO: RECIPIENT, MPP_ENABLED: "1", MPP_SECRET_KEY: "route-pull-secret", CHAT_LAUNCHED: "true" }) as Env;
  const authHeader = (cred: MppCredential) => "Payment " + btoa(JSON.stringify(cred)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const post = async (headers: Record<string, string>) => {
    const ctx = createExecutionContext();
    const r = await worker.fetch(
      new Request("https://d/api/chat/topup", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ ref: "pull-idem-key-1", over18: true }),
        cf: { country: "US" },
      }),
      routeEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return r;
  };

  it("bare probe (no payment) still returns a 402 with BOTH rails", async () => {
    const ctx = createExecutionContext();
    const r = await worker.fetch(
      new Request("https://d/api/chat/topup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", cf: { country: "US" } }),
      routeEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(r.status).toBe(402);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(r.headers.get("WWW-Authenticate")).toMatch(/^Payment /);
  });

  it("a valid pull payment credits + mints a session bound to the RECOVERED payer, with a receipt", async () => {
    await env.DB.prepare("DELETE FROM chat_topups").run();
    const e = routeEnv();
    restore = stubRpc({ receipt: goodReceipt(2_000_000n) });
    const raw = await signTx([transferCall(RECIPIENT, 2_000_000n)]);
    const cred = pullCred(await issue(e), raw);
    const r = await post({ authorization: authHeader(cred) });
    expect(r.status).toBe(200);
    expect(r.headers.get("Payment-Receipt")).toBeTruthy();
    const body = (await r.json()) as { ok: boolean; credited: boolean; address: string; sessionToken: string };
    expect(body.ok).toBe(true);
    expect(body.credited).toBe(true);
    expect(body.address).toBe(SIGNER.toLowerCase()); // session bound to the recovered signer
    expect(body.sessionToken.length).toBeGreaterThan(10);
  });

  it("refuses a REPLAY (same challenge id → order_id conflict), no double-credit", async () => {
    await env.DB.prepare("DELETE FROM chat_topups").run();
    const e = routeEnv();
    restore = stubRpc({ receipt: goodReceipt(2_000_000n) });
    const raw = await signTx([transferCall(RECIPIENT, 2_000_000n)]);
    const cred = pullCred(await issue(e), raw);
    const first = await post({ authorization: authHeader(cred) });
    expect(first.status).toBe(200);
    // Replay the SAME challenge → fast-path returns a session but does NOT re-credit (credited:false).
    const replay = await post({ authorization: authHeader(cred) });
    const rb = (await replay.json()) as { credited?: boolean };
    expect(replay.status).toBe(200);
    expect(rb.credited).toBe(false);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM chat_topups WHERE order_id LIKE 'chattopup:mpp:%'").first<{ n: number }>();
    expect(n?.n).toBe(1); // exactly one settle recorded
  });

  it("refuses a FRESH challenge re-using an already-redeemed tx (settlement_tx unique)", async () => {
    await env.DB.prepare("DELETE FROM chat_topups").run();
    const e = routeEnv();
    restore = stubRpc({ receipt: goodReceipt(2_000_000n) });
    const raw = await signTx([transferCall(RECIPIENT, 2_000_000n)]);
    const first = await post({ authorization: authHeader(pullCred(await issue(e), raw)) });
    expect(first.status).toBe(200);
    // A DIFFERENT challenge, but the SAME signed tx (same settlement_tx) → insert conflict → 402.
    const p2 = await issue(e);
    const second = await post({ authorization: authHeader(pullCred(p2, raw)) });
    expect(second.status).toBe(402);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM chat_topups WHERE order_id LIKE 'chattopup:mpp:%'").first<{ n: number }>();
    expect(n?.n).toBe(1); // no N-spend
  });
});

// silence unused-import lints while keeping the surface explicit
void parseMppAuth;
