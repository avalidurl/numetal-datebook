/**
 * Compatibility-report re-fetch (POST /api/premium/compatibility-report/refetch) — the authenticated,
 * no-recharge way for a member who ALREADY paid to re-read their report, added to undo the same-day
 * lockout the IDOR fix introduced WITHOUT reopening the replay hole. These tests pin the auth boundary:
 * only the wallet whose settled receipt paid for a couple's report can redeliver it, proven by an
 * EIP-191 signature over a nonce+couple-bound message. (The re-gen SUCCESS path needs the AI binding,
 * which the test runtime drops — so we cover redelivery + every fail-closed gate, not model output.)
 */
import { privateKeyToAccount } from "viem/accounts";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { db as makeDb, type DB } from "../src/db/client";
import { couples, ownerWallets, owners, paymentReceipts, personas, premiumOrders } from "../src/db/schema";
import { mintNonce } from "../src/economics/chatcredits";

// Hardhat #0 = the paying member; #1 = an outsider wallet.
const PAYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const OUTSIDER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const STORED = "Ishtar's stored compatibility report for this couple.";

async function newOwner(db: DB, name: string): Promise<number> {
  return (await db.insert(owners).values({ displayName: name, tier: "agent_represented" }).returning({ id: owners.id }).get()).id;
}
async function newPersona(db: DB, ownerId: number, handle: string): Promise<number> {
  return (await db.insert(personas).values({ ownerId, handle, model: "m", heartJson: "sealed", personaAge: "18+", status: "admitted" }).returning({ id: personas.id }).get()).id;
}
async function seedPaidOrder(db: DB, orderId: string, ownerId: number, coupleId: number, payer: string, opts: { status: string; reportText?: string | null }): Promise<void> {
  await db.insert(premiumOrders).values({
    orderId, ownerId, coupleId, sku: "compatibility_report", route: "/api/premium/compatibility-report",
    priceUsd: "$5.00", network: "eip155:8453", facilitator: "cdp", status: opts.status, reportText: opts.reportText ?? null,
  }).run();
  await db.insert(paymentReceipts).values({
    orderId, network: "eip155:8453", facilitator: "cdp", payer: payer.toLowerCase(), payTo: "0xpayto", amountUsdc: "5.000000", status: "settled",
  }).run();
}

function buildMessage(couple: number, nonce: string, o?: { intent?: string; ts?: string; domain?: string }): string {
  const intent = o?.intent ?? "Ishtar compatibility-report re-fetch";
  const domain = o?.domain ?? "ishtar.numetal.xyz";
  const ts = o?.ts ?? new Date().toISOString();
  return `${intent}\n${domain}\ncouple: ${couple}\nnonce: ${nonce}\nissued: ${ts}`;
}

async function refetch(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const ctx = createExecutionContext();
  const r = await worker.fetch(
    new Request("https://d/api/premium/compatibility-report/refetch", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify(body),
      cf: { country: "US" },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("compatibility-report re-fetch", () => {
  let coupleId = 0;
  let ownerA = 0;

  beforeEach(async () => {
    for (const t of ["payment_receipts", "premium_orders", "couples", "personas", "owner_wallets", "owners", "chat_nonces"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
    const db = makeDb(env.DB);
    ownerA = await newOwner(db, "A");
    const ownerB = await newOwner(db, "B");
    const pa = await newPersona(db, ownerA, "@a");
    const pb = await newPersona(db, ownerB, "@b");
    coupleId = (await db.insert(couples).values({ cycleId: "c1", aId: pa, bId: pb }).returning({ id: couples.id }).get()).id;
    // The payer's wallet is bound to ownerA (a member of the couple), as intake would have done.
    await db.insert(ownerWallets).values({ ownerId: ownerA, provider: "external", chainFamily: "evm", network: "eip155:8453", address: PAYER.address.toLowerCase(), status: "active" }).run();
    // A delivered, paid report for this couple, paid by PAYER.
    await seedPaidOrder(db, `cr:${ownerA}:${coupleId}:2026-07-04`, ownerA, coupleId, PAYER.address, { status: "fulfilled", reportText: STORED });
  });

  async function signedBody(account: typeof PAYER, couple = coupleId, o?: Parameters<typeof buildMessage>[2]): Promise<Record<string, unknown>> {
    const nonce = await mintNonce(makeDb(env.DB));
    const message = buildMessage(couple, nonce, o);
    const signature = await account.signMessage({ message });
    return { coupleId: couple, address: account.address, message, signature };
  }

  it("redelivers the stored report to the paying wallet — no re-charge, no re-decrypt", async () => {
    const r = await refetch(await signedBody(PAYER));
    expect(r.status).toBe(200);
    expect(r.json.report).toBe(STORED);
    expect(r.json.redelivered).toBe(true);
  });

  it("404s a wallet that never paid for this couple's report (outsider)", async () => {
    // outsider signs a valid message for their own address, but no receipt has payer=outsider.
    const r = await refetch(await signedBody(OUTSIDER));
    expect(r.status).toBe(404);
  });

  it("401s a signature that does not match the claimed address", async () => {
    const body = await signedBody(PAYER);
    body.address = OUTSIDER.address; // claim a different signer than actually signed
    const r = await refetch(body);
    expect(r.status).toBe(401);
    expect(r.json.report).toBeUndefined();
  });

  it("401s a replayed (already-consumed) nonce", async () => {
    const body = await signedBody(PAYER);
    const first = await refetch(body);
    expect(first.status).toBe(200);
    const replay = await refetch(body); // same nonce+signature
    expect(replay.status).toBe(401);
  });

  it("400s when the signed message binds a different coupleId than the body", async () => {
    // sign for couple 999 but ask for the real coupleId → binding mismatch
    const nonce = await mintNonce(makeDb(env.DB));
    const message = buildMessage(999, nonce);
    const signature = await PAYER.signMessage({ message });
    const r = await refetch({ coupleId, address: PAYER.address, message, signature });
    expect(r.status).toBe(400);
  });

  it("400s a message missing the re-fetch intent (domain separation)", async () => {
    const r = await refetch(await signedBody(PAYER, coupleId, { intent: "Sign in to ishtar" }));
    expect(r.status).toBe(400);
  });

  it("400s a stale (>10 min) timestamp", async () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    const r = await refetch(await signedBody(PAYER, coupleId, { ts: old }));
    expect(r.status).toBe(400);
  });

  it("403 access gate without the venue key", async () => {
    const body = await signedBody(PAYER);
    const ctx = createExecutionContext();
    const r = await worker.fetch(
      new Request("https://d/api/premium/compatibility-report/refetch", {
        method: "POST",
        headers: { "content-type": "application/json" }, // no Bearer
        body: JSON.stringify(body),
        cf: { country: "US" },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(r.status).toBe(403);
  });

  it("re-gen path fails CLOSED: a payer who is no longer a couple member is refused before any decrypt", async () => {
    const db = makeDb(env.DB);
    // A couple the PAYER paid a (failed-generation) report for, but does NOT own either persona.
    const o3 = await newOwner(db, "C");
    const o4 = await newOwner(db, "D");
    const p3 = await newPersona(db, o3, "@c");
    const p4 = await newPersona(db, o4, "@d");
    const outsiderCouple = (await db.insert(couples).values({ cycleId: "c2", aId: p3, bId: p4 }).returning({ id: couples.id }).get()).id;
    // PAYER paid, but generation failed → no reportText. PAYER's wallet resolves to ownerA, not in this couple.
    await seedPaidOrder(db, `cr:${o3}:${outsiderCouple}:2026-07-04`, o3, outsiderCouple, PAYER.address, { status: "failed", reportText: null });
    const r = await refetch(await signedBody(PAYER, outsiderCouple));
    expect(r.status).toBe(403);
    expect(r.json.forbidden).toBe(true);
  });
});
