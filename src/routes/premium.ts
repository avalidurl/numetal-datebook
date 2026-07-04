/**
 * x402 paid SKU — the compatibility report. Free until paid: no X-PAYMENT header →
 * 402 challenge. With payment → settle-then-persist (durable, idempotent, fail-closed),
 * THEN generate the artifact. Never deliver without a verified, persisted receipt.
 */
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { verifyMessage } from "viem";
import { z } from "zod";
import { db as makeDb } from "../db/client";
import { events, premiumOrders } from "../db/schema";
import type { Env } from "../env";
import { utcDay } from "../env";
import { consumeNonce } from "../economics/chatcredits";
import { settleAndPersist } from "../payments/receipts";
import { makeX402Provider, SKUS, x402Challenge } from "../payments/x402";
import { isCoupleMember, loadCoupleMembership, ownerIdForWallet } from "../premium/report-authz";
import { generateAndStoreReport, groundCouple } from "../premium/report-generate";

export const premiumRoutes = new Hono<{ Bindings: Env }>();

const bodySchema = z.object({
  ownerId: z.number().int().positive(),
  coupleId: z.number().int().positive().optional(),
});

premiumRoutes.post("/premium/compatibility-report", async (c) => {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "ownerId required" }, 400);
  const { ownerId, coupleId } = parsed.data;
  if (!c.env.PAY_TO) return c.json({ error: "payments not configured" }, 503);

  // Mainnet (real USDC) runs through the CDP facilitator wired in src/payments/x402.ts (no SDK dep —
  // a hand-rolled EdDSA Bearer JWT + verify→settle). Go-live is founder-gated by config (X402_MODE=mainnet
  // + CDP_API_KEY_* secrets + a mainnet PAY_TO + a real $1 acceptance tx), not by a code guard.
  const db = makeDb(c.env.DB);
  const sku = SKUS.compatibility_report!;
  const provider = makeX402Provider(c.env);
  const orderId = `cr:${ownerId}:${coupleId ?? 0}:${utcDay()}`;

  await db
    .insert(premiumOrders)
    .values({
      orderId,
      ownerId,
      coupleId,
      sku: sku.id,
      route: sku.route,
      priceUsd: sku.priceUsd,
      network: provider.network,
      facilitator: provider.facilitator,
      status: "created",
    })
    .onConflictDoNothing()
    .run();

  // Comped participants (e.g. Ishtar + the Intern for the live dating demo) skip the x402 paywall:
  // the real flow runs end-to-end, just without a charge. Everyone else still pays.
  // The comp list is the env X402_FREE_OWNERS PLUS a runtime-settable `x402_free_owners` setting
  // (so the founder can comp a specific owner via /admin/actions/settings without a redeploy).
  const setFree = String(
    (await c.env.DB.prepare("SELECT value FROM settings WHERE key='x402_free_owners'").first<{ value: string }>())?.value ?? "",
  );
  const comped = `${c.env.X402_FREE_OWNERS || ""},${setFree}`
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(String(ownerId));
  let receiptId: number | null = null;
  // The wallet that actually settled the payment (from x402 verify/settle). This is the caller's PROVEN
  // identity and the ONLY thing that authorizes decrypting a couple's private hearts below. Null on the
  // comped path (no payment) — comped authorization falls back to the founder-allowlisted ownerId.
  let payerWallet: string | null = null;
  // Did THIS request freshly verify a payment? The orderId is client-supplied, so the idempotent-replay
  // path returns a prior member's cached payer to WHOEVER replays the order key. That payer must never
  // authorize the sensitive grounded read — only a freshly-verified payer may (see the gate below).
  let payerFresh = false;
  if (comped) {
    await db.update(premiumOrders).set({ status: "comped" }).where(eq(premiumOrders.orderId, orderId)).run();
  } else {
    const paymentHeader = c.req.header("payment-signature") ?? c.req.header("x-payment"); // v2 ← PAYMENT-SIGNATURE, v1 ← X-PAYMENT
    if (!paymentHeader) {
      await db.update(premiumOrders).set({ status: "challenged" }).where(eq(premiumOrders.orderId, orderId)).run();
      return x402Challenge(c.env, sku, c.env.PAY_TO, orderId);
    }
    const settled = await settleAndPersist(db, c.env, provider, { orderId, sku, payTo: c.env.PAY_TO }, paymentHeader);
    if (!settled.ok) return c.json({ error: "payment not verified", reason: settled.reason }, 402);
    receiptId = settled.receiptId ?? null;
    payerWallet = settled.payer ?? null;
    payerFresh = settled.fresh === true;
  }

  // Ground the report in the actual dating docs + courtship when a couple is named — a report that
  // never reads the hearts is a stub. This DECRYPTS both personas' private hearts, so it is gated
  // behind a couple-membership check (IDOR fix, 2026-07-04): the caller's PROVEN identity — the settled
  // payer wallet, or a founder-comped ownerId — must own one of the couple's two personas. A non-member
  // (or an unresolvable payer) is refused BEFORE any decryption. See src/premium/report-authz.ts.
  let grounding = "";
  if (coupleId) {
    const membership = await loadCoupleMembership(c.env, coupleId);
    if (membership.couple) {
      // Only a FRESHLY-verified payer (or a founder-comped ownerId) may authorize the decrypt. A payer
      // handed back by the idempotent-replay short-circuit is discarded (payerFresh=false → null), so a
      // caller cannot inherit a member's identity by replaying their order key on the same UTC day.
      const callerOwnerId = comped ? ownerId : payerFresh ? await ownerIdForWallet(c.env, payerWallet) : null;
      if (!isCoupleMember(membership, callerOwnerId)) {
        await db.update(premiumOrders).set({ status: "failed" }).where(eq(premiumOrders.orderId, orderId)).run();
        await db
          .insert(events)
          .values({ kind: "premium_report_authz_denied", payload: JSON.stringify({ orderId, coupleId, callerOwnerId, comped, fresh: payerFresh }) })
          .run();
        return c.json(
          { ok: false, orderId, receiptId, report: null, forbidden: true, error: "not authorized: the payer is not a member of this couple" },
          403,
        );
      }
      // Authorized — decrypt both hearts + courtship into the grounding block (shared with re-fetch).
      grounding = await groundCouple(c.env, coupleId);
    }
  }

  // Generate + chaperone + persist (shared with the re-fetch re-gen path). A paid/comped report never
  // silently delivers empty: the helper retries once, then reports failed/withheld distinctly.
  const result = await generateAndStoreReport(db, c.env, { ownerId, coupleId, orderId, grounding });
  if (result.status === "failed") return c.json({ ok: false, orderId, receiptId, error: result.reason, retryable: true }, 502);
  if (result.status === "withheld") return c.json({ ok: true, orderId, receiptId, report: null, withheld: true, reason: result.reason });
  return c.json({ ok: true, orderId, receiptId, report: result.report, sanitized: result.sanitized });
});

// ---------------------------------------------------------------------------------------------------
// Re-fetch / redeliver a report the caller ALREADY paid for — without re-charging and without reopening
// the idempotent-replay hole. The IDOR fix authorizes the paid route only on a FRESHLY-verified payer,
// so a same-UTC-day retry (which short-circuits to a replay) 403s; this endpoint is the safe way back in.
//
// Auth = an EIP-191 signature challenge (no session, no charge): the caller signs a message binding this
// couple + a fresh server nonce (GET /api/chat/nonce), proving control of a wallet. We then serve ONLY a
// report whose settled receipt's own payer == that wallet — so a caller can only ever reach a report they
// actually bought. The receipt's payer was fresh-proven a member at settle time; redelivery of the stored
// artifact needs no re-decrypt. A re-generation (order previously failed generation) DOES decrypt current
// hearts, so it re-checks couple membership now. Fail-closed throughout.
const refetchSchema = z.object({
  coupleId: z.number().int().positive(),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  message: z.string().min(1).max(4000),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
});

premiumRoutes.post("/premium/compatibility-report/refetch", async (c) => {
  const parsed = refetchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "coupleId, address, message, signature required" }, 400);
  const { coupleId, address, message, signature } = parsed.data;
  const db = makeDb(c.env.DB);

  // 1) The signed message must bind THIS re-fetch: the domain, the intent (domain separation from
  //    sign-in / other signed payloads), the exact couple, a fresh server nonce, and a recent timestamp.
  if (!message.includes("ishtar.numetal.xyz")) return c.json({ error: "message must reference ishtar.numetal.xyz" }, 400);
  if (!/compatibility-report re-fetch/i.test(message)) return c.json({ error: "message must state the 'compatibility-report re-fetch' intent" }, 400);
  if (!new RegExp(`couple:\\s*${coupleId}(?!\\d)`).test(message)) return c.json({ error: "message must bind 'couple: <coupleId>' matching the body" }, 400);
  const issued = message.match(/(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/)?.[1];
  const issuedMs = issued ? new Date(issued).getTime() : NaN;
  if (!Number.isFinite(issuedMs) || Math.abs(Date.now() - issuedMs) > 10 * 60_000)
    return c.json({ error: "message must include a valid ISO-8601 timestamp issued within 10 minutes" }, 400);
  const nonce = message.match(/nonce:\s*([a-f0-9]{16,})/i)?.[1];
  if (!nonce) return c.json({ error: "message must include a server nonce — GET /api/chat/nonce first" }, 400);

  // 2) Prove the caller controls `address` (EIP-191), THEN consume the nonce (single-use, replay-proof).
  let valid = false;
  try {
    valid = await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });
  } catch {
    valid = false;
  }
  if (!valid) return c.json({ error: "signature does not match address" }, 401);
  if (!(await consumeNonce(db, nonce))) return c.json({ error: "nonce invalid, expired, or already used — request a new one" }, 401);

  // 3) Find the settled report THIS wallet paid for on THIS couple. The client-supplied ids are NOT the
  //    authorization — the receipt's fresh-proven payer is. Joining on lower(payer)=address means a
  //    caller can only ever reach a report they actually bought.
  const row = await c.env.DB.prepare(
    "SELECT po.order_id AS orderId, po.owner_id AS ownerId, po.status AS status, po.report_text AS reportText " +
      "FROM premium_orders po JOIN payment_receipts pr ON pr.order_id = po.order_id " +
      "WHERE po.couple_id = ?1 AND lower(pr.payer) = lower(?2) ORDER BY pr.id DESC LIMIT 1",
  )
    .bind(coupleId, address)
    .first<{ orderId: string; ownerId: number; status: string; reportText: string | null }>();
  if (!row) return c.json({ error: "no paid compatibility report found for this wallet and couple" }, 404);

  // 4) Already-delivered artifact → redeliver as-is. You paid for it; no re-charge, no re-decrypt.
  if (row.reportText) {
    await db.insert(events).values({ kind: "premium_report_refetch", payload: JSON.stringify({ orderId: row.orderId, coupleId, mode: "redeliver" }) }).run();
    return c.json({ ok: true, orderId: row.orderId, report: row.reportText, redelivered: true });
  }

  // 5) Paid but generation had failed (no stored artifact) → re-generate ONCE. Re-gen DECRYPTS current
  //    hearts, so re-check couple membership NOW (fail-closed) — never re-decrypt for a non-member.
  const membership = await loadCoupleMembership(c.env, coupleId);
  const callerOwnerId = await ownerIdForWallet(c.env, address);
  if (!membership.couple || !isCoupleMember(membership, callerOwnerId)) {
    await db.insert(events).values({ kind: "premium_report_refetch_denied", payload: JSON.stringify({ orderId: row.orderId, coupleId, callerOwnerId }) }).run();
    return c.json({ ok: false, orderId: row.orderId, report: null, forbidden: true, error: "not authorized to regenerate: wallet is not a member of this couple" }, 403);
  }
  const grounding = await groundCouple(c.env, coupleId);
  const result = await generateAndStoreReport(db, c.env, { ownerId: row.ownerId, coupleId, orderId: row.orderId, grounding });
  // A successful re-gen delivered the artifact the payment already covered → restore the order to fulfilled.
  if (result.status === "ok") await db.update(premiumOrders).set({ status: "fulfilled" }).where(eq(premiumOrders.orderId, row.orderId)).run();
  await db.insert(events).values({ kind: "premium_report_refetch", payload: JSON.stringify({ orderId: row.orderId, coupleId, mode: "regenerate", status: result.status }) }).run();
  if (result.status === "failed") return c.json({ ok: false, orderId: row.orderId, report: null, error: result.reason, retryable: true }, 502);
  if (result.status === "withheld") return c.json({ ok: true, orderId: row.orderId, report: null, withheld: true, reason: result.reason });
  return c.json({ ok: true, orderId: row.orderId, report: result.report, regenerated: true, sanitized: result.sanitized });
});
