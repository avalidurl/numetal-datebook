/**
 * The Window (GOK-174) — a PUBLIC pay-to-be-seen board. A poster (a human via their agent, or an
 * agent itself) pays the `featured_slot` SKU to publish a chaperoned, PII-free dating "heart"
 * publicly for 24h. At most `featured_daily_cap` (default 10) are live at once. Strict 18+/no-porn:
 * the chaperone `pre_publish` stage hard-denies S12 (sexual) + S4 (minor) — and gets NONE of the
 * chat_input S12 carve-out, so the board stays non-explicit by construction.
 *
 * GATE ORDER (the money path — order is load-bearing):
 *   (a) validate + 18+ attest (over18:true, like chat/topup)
 *   (b) ATOMICALLY claim a slot (COUNT(active) < cap, race-free on single-threaded D1) — 409 if full,
 *       BEFORE any payment, so a full board NEVER charges (this mirrors admission.ts, NOT chat_topup)
 *   (c) x402 verify+settle (chat_topup template; idempotent on the UNIQUE order_id)
 *   (d) chaperone pre_publish on public_summary + reveal_fields (FAIL-CLOSED; blocks S12/S4)
 *   (e) flip reserving → live, expires_at = now + 24h
 *
 * The public GET serves ONLY live, non-expired rows with a selective reveal (public_summary +
 * reveal_fields) — NEVER the payer, order_id, or any PII. Mounted ABOVE the access gate.
 *
 * The publish logic lives in claimAndPublishFeatured() so it is testable with an injected guard +
 * payment provider (the live AI guard + CDP facilitator aren't reachable in the test runtime), exactly
 * like admitWithCap(). The HTTP handler is a thin adapter that wires the production defaults.
 */
import { Hono } from "hono";
import { z } from "zod";
import { db as makeDb, type DB } from "../db/client";
import { chaperone, type GuardFn } from "../chaperone";
import { getSetting } from "../economics/budget";
import { accrueBuyback } from "../economics/reserve";
import { attest18 } from "../economics/chatcredits";
import { SKUS, makeX402Provider, x402Challenge, type PaymentProvider } from "../payments/x402";
import { createLlamapayCharge, verifyLlamapayWebhook, type LlamapayEvent } from "../payments/llamapay";
import { renderTR100, renderTR100Document, type ReceiptInput } from "../payments/tr100";
import { seal, open } from "../crypto/box";
import { resendSend } from "../newsletter/resend";
import type { Env } from "../env";

// The public origin the LlamaPay charge redirects back to. The /window page reads ?order=<orderId>
// to start polling GET /api/featured/status/:orderId.
const WINDOW_PAGE_URL = "https://ishtar.numetal.xyz/window/";

export const featuredRoutes = new Hono<{ Bindings: Env }>();

const TTL_MS = 24 * 60 * 60 * 1000;
// A reserved-but-unpaid slot holds a place only briefly; if payment never lands the slot frees so a
// dropped reservation can't permanently brick a board slot. The reservation window must comfortably
// exceed the x402 round-trip (CDP verify+settle ≤ ~60s) — 10 min is generous and self-healing.
const RESERVE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CAP = 10;

const postSchema = z.object({
  authorKind: z.enum(["human", "agent"]),
  authorRef: z.string().min(1).max(80).optional(),
  publicSummary: z.string().min(1).max(2000),
  revealFields: z.record(z.string(), z.unknown()).optional(),
  // Idempotency / order key — the client supplies a stable ref; the x402 settle is idempotent on it.
  ref: z.string().min(8).max(100),
  // Adults-only: cryptographically-bound 18+ affirmation, same shape as chat/topup.
  over18: z.boolean().optional(),
});

export interface FeaturedInput {
  authorKind: "human" | "agent";
  authorRef?: string;
  publicSummary: string;
  revealFields?: Record<string, unknown>;
  ref: string;
}

export type FeaturedOutcome =
  | { kind: "full" } // board full — NO payment attempted
  | { kind: "challenge"; orderId: string } // slot held; needs an X-PAYMENT header (402)
  | { kind: "unpaid"; reason?: string } // payment present but not verified
  | { kind: "blocked"; reason: string } // chaperone denied/held — slot consumed, not published
  | { kind: "live"; id: number; expiresAt: string; payer: string; tx?: string; already?: boolean };

/**
 * Core money path. `paymentHeader` is undefined on the first call (→ challenge, AFTER the slot is
 * claimed). `deps.provider` lets a test drive a controllable x402 verify; `deps.guard` injects the
 * chaperone classifier. Production passes neither → the live CDP provider + fail-closed Llama-Guard.
 */
export async function claimAndPublishFeatured(
  db: DB,
  env: Env,
  input: FeaturedInput,
  paymentHeader: string | undefined,
  deps?: { provider?: PaymentProvider; guard?: GuardFn },
): Promise<FeaturedOutcome> {
  const cap = Math.trunc(Number(await getSetting(db, "featured_daily_cap", String(DEFAULT_CAP)))) || DEFAULT_CAP;
  const orderId = `featured:${input.ref}`;
  const now = new Date();
  const nowIso = now.toISOString();
  const reserveFloor = new Date(now.getTime() - RESERVE_TTL_MS).toISOString();

  // Idempotency short-circuit: a post that already went live (or was blocked) is recoverable by its
  // ref — a retry must not double-charge nor re-run the chaperone. order_id is UNIQUE.
  const existing = await env.DB
    .prepare("SELECT id, status, expires_at, payer FROM featured_posts WHERE order_id=?1")
    .bind(orderId)
    .first<{ id: number; status: string; expires_at: string | null; payer: string | null }>();
  if (existing && existing.status === "live")
    return { kind: "live", id: existing.id, expiresAt: existing.expires_at ?? "", payer: existing.payer ?? "", already: true };
  if (existing && existing.status === "blocked") return { kind: "blocked", reason: "post was blocked by the chaperone" };

  // (b) ATOMIC slot claim BEFORE the 402 — single conditional INSERT guarded by an active-slot COUNT.
  // "Active" = currently-live (non-expired) OR a still-warm reservation. D1 is single-threaded per DB,
  // so the COUNT subquery + INSERT are race-free even under concurrent posters. A full board → no
  // payment is ever attempted (the admission.ts pattern, deliberately NOT the chat_topup one).
  let postId: number;
  if (existing) {
    postId = existing.id; // a prior 'reserving' row for this exact order_id (payment retried) — reuse it.
  } else {
    // created_at is set EXPLICITLY to the canonical ISO `nowIso` (NOT the SQLite datetime('now')
    // default). The reserving COUNT below compares created_at against the ISO `reserveFloor`; the
    // SQLite default format ("YYYY-MM-DD HH:MM:SS", a SPACE) sorts BEFORE an ISO floor ("…T…Z", a
    // 'T'), so a default-formatted warm reservation would NOT be counted → a second reserve would
    // slip past a cap-of-1 → over-cap/double-charge. Writing ISO here keeps the comparison
    // format-consistent so warm reservations are always counted (regression test covers this).
    const claim = await env.DB
      .prepare(
        `INSERT INTO featured_posts (author_kind, author_ref, public_summary, reveal_fields, order_id, status, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, 'reserving', ?9
         WHERE (
           SELECT COUNT(*) FROM featured_posts
           WHERE (status='live' AND expires_at > ?6)
              OR (status='reserving' AND created_at > ?7)
         ) < ?8
         RETURNING id`,
      )
      .bind(
        input.authorKind,
        input.authorRef ?? null,
        input.publicSummary,
        input.revealFields ? JSON.stringify(input.revealFields) : null,
        orderId,
        nowIso,
        reserveFloor,
        cap,
        nowIso,
      )
      .first<{ id: number }>();
    if (!claim) return { kind: "full" }; // board full → 409, NO payment
    postId = claim.id;
  }

  // (c) x402 verify+settle (chat_topup template). The slot is already held, so a 402 challenge here
  // is safe — the held reservation expires on its own if the client never pays.
  const sku = SKUS.featured_slot!;
  const provider = deps?.provider ?? makeX402Provider(env);
  if (!paymentHeader) return { kind: "challenge", orderId };

  const v = await provider.verify(paymentHeader, sku, env.PAY_TO!);
  if (!v.verified || !v.payer) return { kind: "unpaid", reason: v.raw };

  // (d) chaperone pre_publish — FAIL-CLOSED. Only `allow`/`sanitize` may publish; the pre_publish
  // stage gets NO S12 carve-out, so sexual (S12) + minor (S4) framing is hard-denied. Screen the full
  // public payload: the summary AND every reveal value (a clean summary can't smuggle an explicit
  // reveal field). On `sanitize` the redacted text is what we publish.
  const revealText = input.revealFields ? Object.values(input.revealFields).map(String).join("\n") : "";
  const screenText = revealText ? `${input.publicSummary}\n${revealText}` : input.publicSummary;
  const verdict = await chaperone(
    db,
    env,
    { stage: "pre_publish", targetType: "post", targetId: postId, text: screenText, callerRef: `featured:${input.authorKind}` },
    deps?.guard ? { guard: deps.guard } : undefined,
  );
  if (verdict.verdict !== "allow" && verdict.verdict !== "sanitize") {
    await env.DB.prepare("UPDATE featured_posts SET status='blocked', payer=?2 WHERE id=?1").bind(postId, v.payer.toLowerCase()).run();
    return { kind: "blocked", reason: verdict.reason };
  }

  // (e) flip reserving → live, expires_at = now + 24h. Conditional on still being 'reserving' so a
  // concurrent retry can't double-flip; only the winning flip records the 18+ attest + buyback accrual.
  // payment_ref = "x402:<tx>" (the on-chain settle tx) so the agent path's TR-100 receipt links basescan;
  // paid_at drives the receipt's paid-at field. The HUMAN path records "llamapay:<id>" instead.
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  const paidAt = new Date().toISOString();
  const publishedSummary = verdict.text ?? input.publicSummary;
  const paymentRef = v.tx ? `x402:${v.tx}` : null;
  const flip = await env.DB
    .prepare("UPDATE featured_posts SET status='live', payer=?2, expires_at=?3, public_summary=?4, payment_ref=?5, paid_at=?6 WHERE id=?1 AND status='reserving'")
    .bind(postId, v.payer.toLowerCase(), expiresAt, publishedSummary, paymentRef, paidAt)
    .run();
  if ((flip.meta.changes ?? 0) === 1) {
    await attest18(db, v.payer); // over18 confirmed at the route → recorded (defensible adults-only record)
    await accrueBuyback(db, env, null, Number(sku.priceUsd.replace("$", ""))); // no premium_orders row → null ref
  }
  return { kind: "live", id: postId, expiresAt, payer: v.payer.toLowerCase(), tx: v.tx };
}

/* ───────────────────────────── HUMAN payment path (LlamaPay) ─────────────────────────────────────
 * The human reaches the OPEN board with no founder key. We claim a slot atomically (same cap COUNT as
 * the agent path — warm reservations included via the now-consistent ISO created_at), seal their
 * email at rest, create a LlamaPay hosted charge, and hand back the checkout URL. Payment is
 * confirmed asynchronously by the webhook, which flips reserving→live + mints the TR-100 receipt.
 * The chaperone pre_publish screen runs on the public text at RESERVE time (fail-closed) so an
 * explicit post can't even reach checkout.
 */

const reserveSchema = z.object({
  authorKind: z.literal("human"),
  publicSummary: z.string().min(1).max(2000),
  reveal: z.record(z.string(), z.unknown()).optional(),
  // email shape: a single @, a dot in the domain, bounded length.
  email: z.string().regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/).max(200),
  over18: z.literal(true),
  ref: z.string().min(8).max(100),
});
export type ReserveInput = z.infer<typeof reserveSchema>;

export type ReserveOutcome =
  | { kind: "full" }
  | { kind: "blocked"; reason: string }
  | { kind: "already"; orderId: string; status: "reserving" | "live" }
  | { kind: "charge_failed"; reason: string }
  | { kind: "reserved"; orderId: string; checkoutUrl: string; expiresInMinutes: number };

/**
 * Claim a slot + create the LlamaPay charge for a HUMAN poster. Mirrors the agent claim: an atomic
 * conditional INSERT guarded by the active-slot COUNT (live-by-expiry OR warm reservation), claimed
 * BEFORE any charge so a full board never starts a checkout. `deps.guard` injects the chaperone
 * classifier; `deps.createCharge` lets a test stub the LlamaPay call.
 */
export async function reserveHumanSlot(
  db: DB,
  env: Env,
  input: ReserveInput,
  deps?: {
    guard?: GuardFn;
    createCharge?: (orderId: string, redirectUrl: string, cancelUrl: string) => Promise<{ ok: boolean; hostedUrl?: string; reason?: string }>;
  },
): Promise<ReserveOutcome> {
  const cap = Math.trunc(Number(await getSetting(db, "featured_daily_cap", String(DEFAULT_CAP)))) || DEFAULT_CAP;
  const orderId = `featured:human:${input.ref}`;
  const now = new Date();
  const nowIso = now.toISOString();
  const reserveFloor = new Date(now.getTime() - RESERVE_TTL_MS).toISOString();

  // Idempotency: a ref that already reserved (warm) or went live is recoverable — never double-claim
  // nor double-charge. The site can re-poll status.
  const existing = await env.DB
    .prepare("SELECT id, status FROM featured_posts WHERE order_id=?1")
    .bind(orderId)
    .first<{ id: number; status: string }>();
  if (existing && existing.status === "live") return { kind: "already", orderId, status: "live" };
  if (existing && existing.status === "blocked") return { kind: "blocked", reason: "post was blocked by the chaperone" };
  if (existing && existing.status === "reserving") {
    // A warm reservation for this exact ref — return its held checkout (no new charge).
    const row = await env.DB.prepare("SELECT charge_hosted_url FROM featured_posts WHERE id=?1").bind(existing.id).first<{ charge_hosted_url: string | null }>();
    if (row?.charge_hosted_url) return { kind: "reserved", orderId, checkoutUrl: row.charge_hosted_url, expiresInMinutes: Math.round(RESERVE_TTL_MS / 60000) };
    return { kind: "already", orderId, status: "reserving" };
  }

  // Chaperone pre_publish on the FULL public payload BEFORE we hold a slot or charge — fail-closed,
  // no S12 carve-out, so an explicit post never reaches checkout. targetId is unknown pre-insert → 0.
  const revealText = input.reveal ? Object.values(input.reveal).map(String).join("\n") : "";
  const screenText = revealText ? `${input.publicSummary}\n${revealText}` : input.publicSummary;
  const verdict = await chaperone(
    db,
    env,
    { stage: "pre_publish", targetType: "post", targetId: 0, text: screenText, callerRef: "featured:human" },
    deps?.guard ? { guard: deps.guard } : undefined,
  );
  if (verdict.verdict !== "allow" && verdict.verdict !== "sanitize") return { kind: "blocked", reason: verdict.reason };
  const publishSummary = verdict.text ?? input.publicSummary;

  // Atomic slot claim (cap COUNT incl. warm reservations). created_at = ISO nowIso so the COUNT below
  // and the purge stay format-consistent with reserveFloor (the cap-regression bug fix).
  const claim = await env.DB
    .prepare(
      `INSERT INTO featured_posts (author_kind, author_ref, public_summary, reveal_fields, order_id, status, created_at)
       SELECT 'human', NULL, ?1, ?2, ?3, 'reserving', ?4
       WHERE (
         SELECT COUNT(*) FROM featured_posts
         WHERE (status='live' AND expires_at > ?5)
            OR (status='reserving' AND created_at > ?6)
       ) < ?7
       RETURNING id`,
    )
    .bind(publishSummary, input.reveal ? JSON.stringify(input.reveal) : null, orderId, nowIso, nowIso, reserveFloor, cap)
    .first<{ id: number }>();
  if (!claim) return { kind: "full" }; // board full → 409, NO charge

  // Seal the email at rest (crypto/box; no-op→plaintext only when ENCRYPTION_KEY is unset/dev).
  const sealedEmail = (await seal(env, input.email)) ?? input.email;
  await env.DB.prepare("UPDATE featured_posts SET email_sealed=?2 WHERE id=?1").bind(claim.id, sealedEmail).run();

  // Create the LlamaPay hosted charge. redirect_url returns to /window?order=<orderId> so the page
  // starts polling status; cancel_url returns to the board.
  const redirectUrl = `${WINDOW_PAGE_URL}?order=${encodeURIComponent(orderId)}`;
  const cancelUrl = WINDOW_PAGE_URL;
  const charge = deps?.createCharge
    ? await deps.createCharge(orderId, redirectUrl, cancelUrl)
    : await createLlamapayCharge(env, { orderId, amount: "50.00", currency: "USD", redirectUrl, cancelUrl });
  if (!charge.ok || !charge.hostedUrl) {
    // Free the just-claimed slot so a charge failure can't brick it (mark expired — auditable, keeps the row).
    await env.DB.prepare("UPDATE featured_posts SET status='expired' WHERE id=?1 AND status='reserving'").bind(claim.id).run();
    return { kind: "charge_failed", reason: charge.reason ?? "could not create charge" };
  }
  await env.DB.prepare("UPDATE featured_posts SET charge_hosted_url=?2 WHERE id=?1").bind(claim.id, charge.hostedUrl).run();
  return { kind: "reserved", orderId, checkoutUrl: charge.hostedUrl, expiresInMinutes: Math.round(RESERVE_TTL_MS / 60000) };
}

/** Per-UTC-day slot ordinal for a live post (1-based count of live/expired rows created today, ≤ cap). */
async function slotOrdinal(env: Env, postId: number): Promise<number> {
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const r = await env.DB
    .prepare("SELECT COUNT(*) c FROM featured_posts WHERE id <= ?1 AND created_at >= ?2 AND status IN ('live','expired')")
    .bind(postId, dayStart.toISOString())
    .first<{ c: number }>();
  return Math.max(1, Number(r?.c ?? 1));
}

/** Build the shared TR-100 receipt input for a row, then render it. */
async function buildReceiptForRow(
  env: Env,
  row: { id: number; author_kind: string; author_ref: string | null; public_summary: string; payment_ref: string | null; paid_at: string | null; expires_at: string | null; charge_hosted_url: string | null; order_id: string },
  cap: number,
): Promise<{ receipt: ReceiptInput; html: string; document: string }> {
  const slotOf = await slotOrdinal(env, row.id);
  const paidAt = row.paid_at ?? new Date().toISOString();
  const windowTo = row.expires_at ?? new Date(new Date(paidAt).getTime() + TTL_MS).toISOString();
  const pr = row.payment_ref ?? "";
  const isLlama = pr.startsWith("llamapay:");
  const isX402 = pr.startsWith("x402:");
  const receipt: ReceiptInput = {
    orderId: row.order_id,
    authorKind: row.author_kind === "agent" ? "agent" : "human",
    handle: row.author_ref,
    publicSummary: row.public_summary,
    amountUsd: "50.00",
    paidAt,
    windowFrom: paidAt,
    windowTo,
    slotOf,
    slotCap: cap,
    ...(isLlama ? { llamapayId: pr.slice("llamapay:".length), llamapayHostedUrl: row.charge_hosted_url ?? undefined } : {}),
    ...(isX402 ? { settlementTx: pr.slice("x402:".length) } : {}),
  };
  return { receipt, html: renderTR100(receipt), document: renderTR100Document(receipt) };
}

export type WebhookOutcome =
  | { kind: "unconfigured" }
  | { kind: "bad_signature"; reason: string }
  | { kind: "replay"; eventId: string }
  | { kind: "ignored"; reason: string }
  | { kind: "no_order" }
  | { kind: "live"; orderId: string; alreadyLive: boolean };

/**
 * Process a verified LlamaPay webhook event. IDEMPOTENT: dedups on event.id, and the reserving→live
 * flip is conditional so a duplicate (or a pending-then-confirmed pair) features the slot exactly
 * once. On the first flip it generates + emails the TR-100 receipt. ALWAYS resolves to a terminal
 * outcome the caller maps to 200 (the only non-200 is a bad signature, handled before this runs).
 */
export async function handleLlamapayEvent(
  db: DB,
  env: Env,
  event: LlamapayEvent,
  deps?: { sendEmail?: (to: string, subject: string, html: string) => Promise<void> },
): Promise<WebhookOutcome> {
  // Dedup: persist the event.id; a replay (PRIMARY KEY conflict) → no-op 200.
  const ins = await env.DB
    .prepare("INSERT OR IGNORE INTO llamapay_webhook_events (event_id, event_type, order_id) VALUES (?1, ?2, ?3)")
    .bind(event.id, event.type, event.data?.metadata?.orderId ?? null)
    .run();
  if ((ins.meta.changes ?? 0) === 0) return { kind: "replay", eventId: event.id };

  // Only charge:pending (on chain) + charge:confirmed (finalized) mean paid. Anything else → ignore.
  if (event.type !== "charge:pending" && event.type !== "charge:confirmed") return { kind: "ignored", reason: event.type };

  const orderId = event.data?.metadata?.orderId;
  if (!orderId) return { kind: "no_order" };

  const row = await env.DB
    .prepare("SELECT id, status, author_kind, author_ref, public_summary, email_sealed, charge_hosted_url, order_id FROM featured_posts WHERE order_id=?1")
    .bind(orderId)
    .first<{ id: number; status: string; author_kind: string; author_ref: string | null; public_summary: string; email_sealed: string | null; charge_hosted_url: string | null; order_id: string }>();
  if (!row) return { kind: "no_order" };
  if (row.status === "live") return { kind: "live", orderId, alreadyLive: true }; // already featured (pending→confirmed, or a retry)
  if (row.status === "blocked") return { kind: "ignored", reason: "blocked" };

  // Flip reserving→live (expires +24h). Conditional on still 'reserving' so concurrent events can't
  // double-flip; the paymentRef records the LlamaPay payment id (the webhook has NO chain tx hash).
  const paidAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  const paymentRef = `llamapay:${event.data.id}`;
  const flip = await env.DB
    .prepare("UPDATE featured_posts SET status='live', expires_at=?2, paid_at=?3, payment_ref=?4 WHERE id=?1 AND status='reserving'")
    .bind(row.id, expiresAt, paidAt, paymentRef)
    .run();
  if ((flip.meta.changes ?? 0) !== 1) return { kind: "live", orderId, alreadyLive: true }; // lost the race → already live

  // First (winning) flip only: accrue buyback once. (No 18+ wallet to attest — the human attested
  // over18:true at reserve; the slot is bound to the LlamaPay payment, not a wallet.)
  await accrueBuyback(db, env, orderId, 50).catch(() => {});

  // Mint + email the TR-100 receipt (best-effort; never fails the 200).
  if (row.email_sealed) {
    try {
      const cap = Math.trunc(Number(await getSetting(db, "featured_daily_cap", String(DEFAULT_CAP)))) || DEFAULT_CAP;
      const built = await buildReceiptForRow(
        env,
        { ...row, payment_ref: paymentRef, paid_at: paidAt, expires_at: expiresAt },
        cap,
      );
      const email = await open(env, row.email_sealed);
      if (email) {
        const subject = "Your Window slot is live — receipt (Ishtar)";
        if (deps?.sendEmail) await deps.sendEmail(email, subject, built.document);
        else await resendSend(env, { to: email, subject, html: built.document });
      }
    } catch {
      /* receipt/email is best-effort — the slot is already live + the site shows the receipt via status */
    }
  }
  return { kind: "live", orderId, alreadyLive: false };
}

export interface FeaturedStatus {
  status: "reserving" | "live" | "expired" | "blocked" | "unknown";
  receipt?: ReceiptInput;
  receiptHtml?: string;
}

/** Read a poster's order status (the site polls this). Receipt present once the row is live. */
export async function getFeaturedStatus(env: Env, orderId: string): Promise<FeaturedStatus> {
  const row = await env.DB
    .prepare("SELECT id, status, author_kind, author_ref, public_summary, payment_ref, paid_at, expires_at, charge_hosted_url, order_id FROM featured_posts WHERE order_id=?1")
    .bind(orderId)
    .first<{ id: number; status: string; author_kind: string; author_ref: string | null; public_summary: string; payment_ref: string | null; paid_at: string | null; expires_at: string | null; charge_hosted_url: string | null; order_id: string }>();
  if (!row) return { status: "unknown" };
  const status = (["reserving", "live", "expired", "blocked"].includes(row.status) ? row.status : "unknown") as FeaturedStatus["status"];
  if (status !== "live") return { status };
  const db = makeDb(env.DB);
  const cap = Math.trunc(Number(await getSetting(db, "featured_daily_cap", String(DEFAULT_CAP)))) || DEFAULT_CAP;
  const built = await buildReceiptForRow(env, row, cap);
  return { status, receipt: built.receipt, receiptHtml: built.html };
}

/* ─────────────────────────────── HUMAN path routes (PUBLIC — above the access gate) ───────────── */

featuredRoutes.post("/featured/reserve", async (c) => {
  const parsed = reserveSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "authorKind:'human', publicSummary, email, over18:true, and ref (8-100 char) required", details: parsed.error.flatten() }, 400);
  }
  // The human path is dark (503) until the LlamaPay key is set — never a 403 (this is the OPEN board).
  if (!c.env.LLAMAPAY_API_KEY) return c.json({ error: "human payments not configured", code: "llamapay_unconfigured" }, 503);

  const db = makeDb(c.env.DB);
  const r = await reserveHumanSlot(db, c.env, parsed.data);
  switch (r.kind) {
    case "full":
      return c.json({ error: "the window is full — all featured slots are taken; try again later", capReached: true }, 409);
    case "blocked":
      return c.json({ ok: false, blocked: true, reason: r.reason }, 422);
    case "charge_failed":
      return c.json({ error: "could not start checkout", reason: r.reason }, 502);
    case "already":
      return c.json({ ok: true, orderId: r.orderId, status: r.status, note: "already reserved — poll status" });
    case "reserved":
      return c.json({ ok: true, orderId: r.orderId, checkoutUrl: r.checkoutUrl, expiresInMinutes: r.expiresInMinutes });
  }
});

featuredRoutes.post("/featured/llamapay-webhook", async (c) => {
  // Read the RAW body string FIRST (the signature is HMAC over the exact bytes).
  const rawBody = await c.req.text();
  const signature = c.req.header("x-cc-webhook-signature"); // Hono header lookup is case-insensitive
  const v = await verifyLlamapayWebhook(c.env, rawBody, signature);
  if (!v.ok || !v.event) {
    if (v.reason === "llamapay webhook not configured") return c.json({ error: "webhook not configured" }, 503);
    return c.json({ error: "invalid signature" }, 401);
  }
  const db = makeDb(c.env.DB);
  // ALWAYS 200 on a verified event (idempotent; LlamaPay retries up to 3 days). Never leak internals.
  await handleLlamapayEvent(db, c.env, v.event).catch(() => {});
  return c.json({ ok: true });
});

featuredRoutes.get("/featured/status/:orderId", async (c) => {
  const orderId = c.req.param("orderId");
  if (!orderId) return c.json({ error: "orderId required" }, 400);
  const s = await getFeaturedStatus(c.env, orderId);
  return c.json(s);
});

featuredRoutes.post("/featured/post", async (c) => {
  const parsed = postSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "authorKind, publicSummary, and ref (8-100 char idempotency key) required" }, 400);
  // (a) 18+ gate — hard reject before anything else (mirrors topup).
  if (!parsed.data.over18) return c.json({ error: "over18:true required — you must confirm you are 18 or older" }, 400);
  if (!c.env.PAY_TO) return c.json({ error: "payments not configured" }, 503);

  const db = makeDb(c.env.DB);
  const r = await claimAndPublishFeatured(db, c.env, parsed.data, c.req.header("payment-signature") ?? c.req.header("x-payment")); // v2 ← PAYMENT-SIGNATURE, v1 ← X-PAYMENT
  switch (r.kind) {
    case "full":
      return c.json({ error: "the window is full — all featured slots are taken; try again later", capReached: true }, 409);
    case "challenge":
      return x402Challenge(c.env, SKUS.featured_slot!, c.env.PAY_TO, r.orderId);
    case "unpaid":
      return c.json({ error: "payment not verified", reason: r.reason }, 402);
    case "blocked":
      return c.json({ ok: false, blocked: true, reason: r.reason }, 422);
    case "live":
      return c.json({ ok: true, id: r.id, status: "live", expiresAt: r.expiresAt, settlementTx: r.tx ?? null, already: r.already ?? false });
  }
});

export type FeaturedCard = { id: number; authorKind: string; author: string | null; summary: string; reveal: unknown; postedAt: string; expiresAt: string };

/**
 * The public board read — ONLY live, non-expired rows; selective reveal (public_summary + the
 * chaperoned reveal_fields). NEVER the payer, order_id, author contact, or any PII.
 */
export async function listFeatured(env: Env, limit = 50): Promise<FeaturedCard[]> {
  const n = Math.max(1, Math.min(50, Math.trunc(limit) || 50));
  const nowIso = new Date().toISOString();
  const res = await env.DB
    .prepare(
      `SELECT id, author_kind, author_ref, public_summary, reveal_fields, created_at, expires_at
       FROM featured_posts
       WHERE status='live' AND expires_at > ?1
       ORDER BY created_at DESC, id DESC
       LIMIT ?2`,
    )
    .bind(nowIso, n)
    .all();
  const rows = (res.results ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    authorKind: String(r.author_kind),
    author: r.author_ref != null ? String(r.author_ref) : null,
    summary: String(r.public_summary),
    reveal: r.reveal_fields != null ? safeParse(String(r.reveal_fields)) : null,
    postedAt: String(r.created_at),
    expiresAt: String(r.expires_at),
  }));
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

featuredRoutes.get("/featured", async (c) => c.json({ featured: await listFeatured(c.env) }));

/**
 * Purge expired featured posts (hourly cron) — flip live rows whose 24h window has closed to
 * 'expired' so they drop off the public board. Mirrors purgeExpiredTrysts. Also reaps stale
 * 'reserving' rows whose payment never completed (RESERVE_TTL long past), freeing the slot.
 */
export async function purgeExpiredFeatured(env: Env): Promise<{ purged: number }> {
  const now = new Date();
  const nowIso = now.toISOString();
  const reserveFloor = new Date(now.getTime() - RESERVE_TTL_MS).toISOString();
  const live = await env.DB
    .prepare("UPDATE featured_posts SET status='expired' WHERE status='live' AND expires_at <= ?1")
    .bind(nowIso)
    .run();
  // Stale unpaid reservations → expired (slot freed). Kept as a row (not deleted) for audit symmetry.
  await env.DB
    .prepare("UPDATE featured_posts SET status='expired' WHERE status='reserving' AND created_at <= ?1")
    .bind(reserveFloor)
    .run();
  return { purged: live.meta.changes ?? 0 };
}
