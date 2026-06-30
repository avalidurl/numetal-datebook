/**
 * The Window (REDACTED-ID) — a PUBLIC pay-to-be-seen board. A poster (a human via their agent, or an
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
import { admitWithCap } from "../admission";
import { owners } from "../db/schema";
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
    // The AGENT x402 path deliberately leaves owner_id/persona_id NULL. We do NOT stamp a persona link
    // from the client-supplied authorRef: nothing proves the caller OWNS that handle, so matching it
    // against personas.handle would let an attacker paste a victim's public handle, pay, and graft the
    // victim's owner_id onto their post — tripping the human match-notify gate into an unsolicited
    // "you have a match" email (paid griefing; breaks the no-unsolicited-email rule). An agent is its
    // own dater: it matches via the persona IT enrolled through /personas, keyed by its own identity —
    // NOT by a featured row's owner_id. owner_id is set ONLY by the trusted server-side
    // enrolFeaturedHuman for a real human payer.
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
  // reveal is a single free-text blurb (<=400 chars). The client sends a STRING (finding #1: was a
  // record, which 400'd on a plain string + mis-derived the screen text via Object.values).
  reveal: z.string().max(400).optional(),
  // email shape: a single @, a dot in the domain, bounded length.
  email: z.string().regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/).max(200),
  over18: z.literal(true),
  // NOTE: the client NO LONGER sends `ref`. The server GENERATES the authoritative order id
  // (crypto.randomUUID) — finding #2 (entropy + IDOR). callerIp scopes the slot-squatting control.
});
export type ReserveInput = z.infer<typeof reserveSchema>;

export type ReserveOutcome =
  | { kind: "full" }
  | { kind: "blocked"; reason: string }
  | { kind: "squatting"; reason: string } // an outstanding unpaid reservation already held by this IP
  | { kind: "charge_failed"; reason: string }
  | { kind: "reserved"; orderId: string; checkoutUrl: string; expiresInMinutes: number };

/**
 * Claim a slot + create the LlamaPay charge for a HUMAN poster. Mirrors the agent claim: an atomic
 * conditional INSERT guarded by the active-slot COUNT (live-by-expiry OR warm reservation), claimed
 * BEFORE the chaperone + charge so a full board never spends compute or starts a checkout (finding #5).
 * The server GENERATES the order id (crypto.randomUUID) — never derived from a client value (finding
 * #2). `callerIp` keys the chaperone callerRef per-poster and caps outstanding unpaid reservations
 * (finding #6). `deps.guard` injects the chaperone classifier; `deps.createCharge` stubs the LlamaPay
 * call; `deps.orderId` lets a test pin the generated id.
 */
export async function reserveHumanSlot(
  db: DB,
  env: Env,
  input: ReserveInput,
  callerIp: string | undefined,
  deps?: {
    guard?: GuardFn;
    createCharge?: (orderId: string, redirectUrl: string, cancelUrl: string) => Promise<{ ok: boolean; hostedUrl?: string; reason?: string }>;
    orderId?: string;
  },
): Promise<ReserveOutcome> {
  const cap = Math.trunc(Number(await getSetting(db, "featured_daily_cap", String(DEFAULT_CAP)))) || DEFAULT_CAP;
  const priceUsd = await featuredPriceUsd(db); // runtime knob — what the human is actually charged
  // The order id is server-authoritative + high-entropy (finding #2): a uuid the client can't predict
  // or forge, so it can't enumerate another poster's status (IDOR) or collide order rows.
  const orderId = deps?.orderId ?? `featured:human:${crypto.randomUUID()}`;
  const now = new Date();
  const nowIso = now.toISOString();
  const reserveFloor = new Date(now.getTime() - RESERVE_TTL_MS).toISOString();
  const ipKey = callerIp && callerIp.trim() ? callerIp.trim() : null;

  // Anti-squatting (finding #6): cap OUTSTANDING unpaid (still-warm 'reserving') reservations per IP to
  // 1. A second concurrent unpaid reserve from the same IP is rejected until the first is paid (→ live)
  // or expires (RESERVE_TTL). Without this, cap+rate-limit alone let one IP hold every slot unpaid.
  if (ipKey) {
    const outstanding = await env.DB
      .prepare("SELECT COUNT(*) c FROM featured_posts WHERE status='reserving' AND created_at > ?1 AND reserver_ip=?2")
      .bind(reserveFloor, ipKey)
      .first<{ c: number }>();
    if (Number(outstanding?.c ?? 0) >= 1)
      return { kind: "squatting", reason: "you already have an unpaid reservation — pay or wait for it to expire before reserving another" };
  }

  // (b) ATOMIC slot claim FIRST (finding #5) — exactly like claimAndPublishFeatured: the conditional
  // INSERT guarded by the active-slot COUNT (live-by-expiry OR warm reservation) so a full board NEVER
  // runs the chaperone (Workers-AI compute) or starts a charge. created_at = ISO nowIso keeps the COUNT
  // + purge format-consistent with reserveFloor (the cap-regression fix). reserver_ip scopes #6.
  const claim = await env.DB
    .prepare(
      `INSERT INTO featured_posts (author_kind, author_ref, public_summary, reveal_fields, order_id, status, created_at, reserver_ip)
       SELECT 'human', NULL, ?1, ?2, ?3, 'reserving', ?4, ?8
       WHERE (
         SELECT COUNT(*) FROM featured_posts
         WHERE (status='live' AND expires_at > ?5)
            OR (status='reserving' AND created_at > ?6)
       ) < ?7
       RETURNING id`,
    )
    .bind(input.publicSummary, input.reveal ?? null, orderId, nowIso, nowIso, reserveFloor, cap, ipKey)
    .first<{ id: number }>();
  if (!claim) return { kind: "full" }; // board full → 409, NO chaperone, NO charge

  // (d) ONLY AFTER the slot is secured: chaperone pre_publish on the FULL public payload — fail-closed,
  // no S12 carve-out, so an explicit post never reaches checkout. callerRef is keyed per-poster (the
  // orderId + IP), NOT the constant "featured:human" (finding #5). If blocked, RELEASE the slot.
  const revealText = input.reveal ?? "";
  const screenText = revealText ? `${input.publicSummary}\n${revealText}` : input.publicSummary;
  const verdict = await chaperone(
    db,
    env,
    { stage: "pre_publish", targetType: "post", targetId: claim.id, text: screenText, callerRef: `featured:human:${ipKey ?? orderId}` },
    deps?.guard ? { guard: deps.guard } : undefined,
  );
  if (verdict.verdict !== "allow" && verdict.verdict !== "sanitize") {
    // Release the just-claimed slot so a blocked post can't squat it (mark blocked — auditable, frees cap).
    await env.DB.prepare("UPDATE featured_posts SET status='blocked' WHERE id=?1 AND status='reserving'").bind(claim.id).run();
    return { kind: "blocked", reason: verdict.reason };
  }
  const publishSummary = verdict.text ?? input.publicSummary;

  // Seal the email at rest (crypto/box; no-op→plaintext only when ENCRYPTION_KEY is unset/dev). Persist
  // the (possibly sanitized) summary alongside it.
  const sealedEmail = (await seal(env, input.email)) ?? input.email;
  await env.DB.prepare("UPDATE featured_posts SET email_sealed=?2, public_summary=?3 WHERE id=?1").bind(claim.id, sealedEmail, publishSummary).run();

  // Create the LlamaPay hosted charge. redirect_url returns to /window?order=<orderId> so the page
  // starts polling status; cancel_url returns to the board.
  const redirectUrl = `${WINDOW_PAGE_URL}?order=${encodeURIComponent(orderId)}`;
  const cancelUrl = WINDOW_PAGE_URL;
  const charge = deps?.createCharge
    ? await deps.createCharge(orderId, redirectUrl, cancelUrl)
    : await createLlamapayCharge(env, { orderId, amount: priceUsd, currency: "USD", redirectUrl, cancelUrl });
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

/** The live featured-slot price in USD ("X.XX") — a runtime knob ('featured_price_usd') read in the
 * route so it changes WITHOUT a redeploy (the SKU's $50 is only the catalog default). Normalized to
 * digits+dot and required positive, else the $50 default. Governs the human (LlamaPay) charge + receipt. */
async function featuredPriceUsd(db: DB): Promise<string> {
  const raw = (await getSetting(db, "featured_price_usd", "50.00")).replace(/[^0-9.]/g, "");
  return raw && Number(raw) > 0 ? raw : "50.00";
}

/** Build the shared TR-100 receipt input for a row, then render it. */
async function buildReceiptForRow(
  env: Env,
  row: { id: number; author_kind: string; author_ref: string | null; public_summary: string; payment_ref: string | null; paid_at: string | null; expires_at: string | null; charge_hosted_url: string | null; order_id: string },
  cap: number,
  priceUsd: string,
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
    amountUsd: priceUsd,
    paidAt,
    windowFrom: paidAt,
    windowTo,
    slotOf,
    slotCap: cap,
    // Human/LlamaPay path: expose ONLY the public-safe hosted payment URL (charge_hosted_url) — NEVER
    // the internal "llamapay:<id>" (finding #2: the status receipt JSON must not leak the payment id).
    ...(isLlama ? { llamapayHostedUrl: row.charge_hosted_url ?? undefined } : {}),
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
  | { kind: "orphaned"; orderId: string } // paid but unfeaturable (board full) — recorded for refund/comp
  | { kind: "live"; orderId: string; alreadyLive: boolean };

/** Fire a "paid but unfeatured" page to the alert webhook (best-effort; never throws). */
async function alertOrphanedPayment(env: Env, orderId: string, paymentId: string): Promise<void> {
  if (!env.ALERT_WEBHOOK_URL) return;
  try {
    await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `🚨 The Window: PAID BUT UNFEATURED — needs refund/comp. order=${orderId} llamapay=${paymentId} (board was full when the payment confirmed)`,
      }),
    });
  } catch {
    /* alerting must never break the webhook 200 */
  }
}

/* ───────────────────────────── ENROL-ON-FEATURE ─────────────────────────────────────────────────
 * When a featured HUMAN's payment confirms (the winning flip→live), enrol them as a matchable persona
 * so their agent courts on the floor — the prerequisite behind match-notify. We REUSE the exact onboard
 * path /personas uses: create an owner (sealed email as contactRef + 18+ attest carried from reserve),
 * then admitWithCap() with the post's public_summary (+ reveal note) as the heart. admitWithCap sets the
 * persona to status='admitted', which IS what makes it matchable — the match coordinator selects
 * candidates by `personas.status='admitted'`, so admission auto-enrols into courtship (no extra step).
 *
 * IDEMPOTENT AT THE WRITE (not just on the post's owner_id). Two layers:
 *   1. Fast skip: if featured_posts.owner_id is already set (a clean prior enrol), return immediately.
 *   2. Reuse-on-rerun: the persona handle is DETERMINISTIC (`window-<order_id>`, unique-constrained), so
 *      BEFORE inserting we look the persona up by that handle. If a prior run already created it but the
 *      final link UPDATE never landed (a throw between admit and link left the post's owner_id NULL and
 *      the owner ORPHANED), we REUSE that owner/persona and just (re)link — we do NOT insert a second
 *      owner. This is what makes enrol idempotent across a partial failure, not only a clean replay.
 * The (re)link UPDATE is guarded `WHERE id=? AND owner_id IS NULL` so a concurrent winner can't be
 * clobbered. The slot's owner_id is THE shared contract the match-notify sibling joins on.
 *
 * Contact REVEAL stays gated DOWNSTREAM (identity_verified + intro consent + 18+ at reveal time): the
 * sealed email becomes the owner's contactRef, which is NEVER served to boards — enrol only makes the
 * persona matchable, it does NOT reveal the human's contact.
 */
export async function enrolFeaturedHuman(
  db: DB,
  env: Env,
  post: {
    id: number;
    order_id: string;
    public_summary: string;
    reveal_fields?: string | null;
    email_sealed: string | null;
    author_ref?: string | null;
    owner_id?: number | null;
  },
  deps?: { guard?: GuardFn },
): Promise<{ enrolled: boolean; ownerId?: number; personaId?: number; reason?: string }> {
  // Idempotency (layer 1): owner_id already linked → this post was enrolled on a prior winning flip. Skip.
  if (post.owner_id != null) return { enrolled: false, reason: "already enrolled" };

  // The persona handle is DETERMINISTIC + unique-constrained: one persona per featured order. It is also
  // the idempotency anchor — a re-run resolves to the SAME handle, so a prior (even partially-failed)
  // enrol is discoverable here.
  const handle = `window-${post.order_id}`.slice(0, 64);

  // Idempotency (layer 2): reuse-on-rerun. If a prior enrol already created the persona for this order
  // but the final link UPDATE never landed (a throw after admit left the owner ORPHANED and the post's
  // owner_id NULL), find it by the deterministic handle and REUSE its owner/persona — do NOT insert a
  // second owner. This makes a re-claim after a partial failure converge to EXACTLY ONE owner+persona.
  const existingPersona = await env.DB
    .prepare("SELECT id, owner_id FROM personas WHERE handle=?1")
    .bind(handle)
    .first<{ id: number; owner_id: number | null }>();
  if (existingPersona) {
    // (Re)link the post to the already-existing owner/persona. Guarded `owner_id IS NULL` so a concurrent
    // winner is never clobbered. If owner_id is somehow null on the persona we still relink the post's
    // persona_id and leave owner_id as-is (the persona row is the source of truth for the owner).
    if (existingPersona.owner_id != null) {
      await env.DB
        .prepare("UPDATE featured_posts SET owner_id=?2, persona_id=?3 WHERE id=?1 AND owner_id IS NULL")
        .bind(post.id, existingPersona.owner_id, existingPersona.id)
        .run();
    }
    return {
      enrolled: true,
      ownerId: existingPersona.owner_id ?? undefined,
      personaId: existingPersona.id,
      reason: "reused existing persona (re-link)",
    };
  }

  // Create the owner exactly like the onboard heart-file path: the sealed email is the private
  // contactRef (already sealed at reserve in email_sealed — re-used verbatim, never re-plaintexted),
  // tier=agent_represented (no human login), 18+ attested (the human affirmed over18:true at reserve so
  // the slot can only exist for an adult). The owner starts admitted — a featured, paid human is a
  // first-class participant, not a pending applicant.
  const ownerRow = await db
    .insert(owners)
    .values({
      displayName: post.author_ref ?? null,
      contactRef: post.email_sealed, // already sealed at reserve; NEVER served to boards
      tier: "agent_represented",
      ageAttested: 1, // carried 18+ attestation from the reserve gate
      status: "admitted",
    })
    .returning({ id: owners.id })
    .get();
  const ownerId = ownerRow.id;

  // The dating "heart": the chaperoned public_summary the human published, plus the reveal note. This is
  // the same shape /personas feeds admitWithCap (heartText).
  const revealNote = post.reveal_fields ? String(post.reveal_fields).trim() : "";
  const heartText = revealNote ? `${post.public_summary}\n\n${revealNote}` : post.public_summary;

  // SAME admission path /personas uses → atomic cap + fail-closed chaperone. persona_age MUST be "18+"
  // (carried from the reserve over18 gate). The chaperone already passed pre_publish at reserve; the
  // admission chaperone is a second, independent fail-closed gate (defense in depth) on the heart. The
  // unique handle means a re-run that reached this point (no prior persona) inserts exactly once; a
  // re-run AFTER this point is caught by the reuse-lookup above (same handle) and never reinserts.
  const admit = await admitWithCap(
    db,
    env,
    {
      handle,
      model: "@cf/meta/llama-3.1-8b-instruct", // a default conversational model for the human's agent persona
      personaAge: "18+",
      heartText,
      ownerId,
    },
    deps?.guard ? { guard: deps.guard } : undefined,
  );

  // Link the post → owner/persona. owner_id is the shared-contract link; set it even if the cap was full
  // (the persona stays 'pending' and admits on a later cycle) so the enrol is recorded + idempotent.
  // Guarded `owner_id IS NULL` so a concurrent winner can't be clobbered (a partial-failure re-run that
  // reused the persona above already set owner_id; this UPDATE then no-ops). The persona row was already
  // inserted by admitWithCap above, so even if THIS UPDATE throws, the re-claim's reuse-lookup finds the
  // persona by handle and converges — no orphaned owner.
  await env.DB
    .prepare("UPDATE featured_posts SET owner_id=?2, persona_id=?3 WHERE id=?1 AND owner_id IS NULL")
    .bind(post.id, ownerId, admit.personaId ?? null)
    .run();

  return { enrolled: true, ownerId, personaId: admit.personaId, reason: admit.reason };
}

/**
 * Process a verified LlamaPay webhook event. IDEMPOTENT and crash-safe (findings #3 + #4):
 *   - The dedup INSERT is written ONLY AFTER the feature/flip (or terminal orphaned-decision) succeeds,
 *     so a throw mid-handler leaves the event un-deduped → LlamaPay retries it (no permanent drop). A
 *     truly-processed event replays as a 200 no-op (the row is already live/orphaned + the dedup row exists).
 *   - A verified charge for an order whose row is NOT reserving/live/blocked (expired or purged) is NOT
 *     silently dropped: we try to RE-CLAIM a slot (expired→live if the cap has room) and feature+receipt
 *     as normal; if the board is FULL we persist the paid event to featured_orphaned_payments, fire an
 *     alert, and set the row to 'orphaned' so GET /status reports paidButUnfeatured.
 * ALWAYS resolves to a terminal outcome the caller maps to 200 (the only non-200 is a bad signature).
 */
export async function handleLlamapayEvent(
  db: DB,
  env: Env,
  event: LlamapayEvent,
  deps?: { sendEmail?: (to: string, subject: string, html: string) => Promise<void>; guard?: GuardFn },
): Promise<WebhookOutcome> {
  // Replay short-circuit: a truly-processed event was recorded in llamapay_webhook_events at the END of
  // a prior successful run → no-op 200. (We do NOT write the dedup row here — finding #4 moves it to the
  // end so a mid-handler throw leaves the event retryable.)
  const seen = await env.DB
    .prepare("SELECT 1 FROM llamapay_webhook_events WHERE event_id=?1")
    .bind(event.id)
    .first<{ 1: number }>();
  if (seen) return { kind: "replay", eventId: event.id };

  // markProcessed records the dedup row; called ONLY on a terminal success so retries can re-drive a
  // throw. INSERT OR IGNORE keeps it safe even under a concurrent duplicate.
  const markProcessed = async () => {
    await env.DB
      .prepare("INSERT OR IGNORE INTO llamapay_webhook_events (event_id, event_type, order_id) VALUES (?1, ?2, ?3)")
      .bind(event.id, event.type, event.data?.metadata?.orderId ?? null)
      .run();
  };

  // Only charge:pending (on chain) + charge:confirmed (finalized) mean paid. Anything else → ignore (and
  // mark processed so we don't reprocess a benign non-paying event forever).
  if (event.type !== "charge:pending" && event.type !== "charge:confirmed") {
    await markProcessed();
    return { kind: "ignored", reason: event.type };
  }

  const orderId = event.data?.metadata?.orderId;
  if (!orderId) {
    await markProcessed();
    return { kind: "no_order" };
  }

  const row = await env.DB
    .prepare("SELECT id, status, author_kind, author_ref, public_summary, reveal_fields, email_sealed, charge_hosted_url, order_id, owner_id FROM featured_posts WHERE order_id=?1")
    .bind(orderId)
    .first<{ id: number; status: string; author_kind: string; author_ref: string | null; public_summary: string; reveal_fields: string | null; email_sealed: string | null; charge_hosted_url: string | null; order_id: string; owner_id: number | null }>();
  if (!row) {
    await markProcessed();
    return { kind: "no_order" };
  }
  if (row.status === "live") {
    await markProcessed();
    return { kind: "live", orderId, alreadyLive: true }; // already featured (pending→confirmed, or a retry)
  }
  if (row.status === "blocked") {
    await markProcessed();
    return { kind: "ignored", reason: "blocked" };
  }
  if (row.status === "orphaned") {
    await markProcessed();
    return { kind: "orphaned", orderId }; // already recorded as paid-but-unfeatured
  }

  const nowIso = new Date().toISOString();
  const paidAt = nowIso;
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  const paymentRef = `llamapay:${event.data.id}`;
  const cap = Math.trunc(Number(await getSetting(db, "featured_daily_cap", String(DEFAULT_CAP)))) || DEFAULT_CAP;
  const priceUsd = await featuredPriceUsd(db); // the price in effect when this payment confirmed
  const reserveFloor = new Date(Date.now() - RESERVE_TTL_MS).toISOString();

  // Flip to live. For a still-'reserving' row this is an unconditional-on-status flip. For an 'expired'
  // (or otherwise-purged) row this is a RE-CLAIM (finding #3): only flip if the cap has room, counted
  // atomically in the same UPDATE so it can't over-admit. The occupancy COUNT measures CURRENT live rows
  // (expires_at > now) + warm reservations — NOT against the new +24h expiry. Guarded so a concurrent
  // event can't double-flip.
  const flip = await env.DB
    .prepare(
      `UPDATE featured_posts SET status='live', expires_at=?2, paid_at=?3, payment_ref=?4
       WHERE id=?1
         AND status IN ('reserving','expired')
         AND (
           status='reserving'
           OR (
             SELECT COUNT(*) FROM featured_posts
             WHERE (status='live' AND expires_at > ?5)
                OR (status='reserving' AND created_at > ?6)
           ) < ?7
         )`,
    )
    .bind(row.id, expiresAt, paidAt, paymentRef, nowIso, reserveFloor, cap)
    .run();

  if ((flip.meta.changes ?? 0) !== 1) {
    // We did NOT feature it. Re-read to disambiguate: a concurrent event may have just made it live, OR
    // the board is full so this paid event is orphaned. NEVER drop a paid event with no record.
    const after = await env.DB.prepare("SELECT status FROM featured_posts WHERE id=?1").bind(row.id).first<{ status: string }>();
    if (after?.status === "live") {
      await markProcessed();
      return { kind: "live", orderId, alreadyLive: true }; // lost the race → already live
    }
    // Board full → record the paid-but-unfeatured event (idempotent on order_id+payment_id) + alert +
    // mark the row 'orphaned' so GET /status returns paidButUnfeatured.
    await env.DB
      .prepare(
        "INSERT OR IGNORE INTO featured_orphaned_payments (order_id, llamapay_payment_id, email_sealed, amount, received_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      )
      .bind(orderId, event.data.id, row.email_sealed ?? null, priceUsd, paidAt)
      .run();
    await env.DB
      .prepare("UPDATE featured_posts SET status='orphaned', paid_at=?2, payment_ref=?3 WHERE id=?1 AND status IN ('expired','reserving')")
      .bind(row.id, paidAt, paymentRef)
      .run();
    await alertOrphanedPayment(env, orderId, event.data.id);
    await markProcessed(); // terminal decision recorded → safe to dedup
    return { kind: "orphaned", orderId };
  }

  // First (winning) flip only: accrue buyback once. (No 18+ wallet to attest — the human attested
  // over18:true at reserve; the slot is bound to the LlamaPay payment, not a wallet.)
  await accrueBuyback(db, env, orderId, Number(priceUsd)).catch(() => {});

  // ENROL-ON-FEATURE: a HUMAN poster becomes a matchable persona the moment their slot goes live, so
  // their agent courts on the floor (the prerequisite behind match-notify). REUSES the /personas onboard
  // path (admitWithCap) and is idempotent on featured_posts.owner_id — a replay finds it already set and
  // skips. The AGENT x402 path is enrolled at publish (claimAndPublishFeatured), NOT here. Best-effort:
  // a throw before markProcessed leaves the event un-deduped → LlamaPay retries → enrol re-drives (and
  // its owner_id guard prevents a double-enrol). Reveal stays gated downstream — this only matchmakes.
  if (row.author_kind === "human") {
    await enrolFeaturedHuman(db, env, row, deps?.guard ? { guard: deps.guard } : undefined).catch(() => {});
  }

  // Mint + email the TR-100 receipt (best-effort; never fails the 200). Record the send outcome on the
  // row (finding #7) so GET /status can report emailSent.
  let emailed = false;
  if (row.email_sealed) {
    try {
      const built = await buildReceiptForRow(
        env,
        { ...row, payment_ref: paymentRef, paid_at: paidAt, expires_at: expiresAt },
        cap,
        priceUsd,
      );
      const email = await open(env, row.email_sealed);
      if (email) {
        const subject = "Your Window slot is live — receipt (Ishtar)";
        if (deps?.sendEmail) await deps.sendEmail(email, subject, built.document);
        else await resendSend(env, { to: email, subject, html: built.document });
        emailed = true;
      }
    } catch {
      /* receipt/email is best-effort — the slot is already live + the site shows the receipt via status */
    }
  }
  await env.DB.prepare("UPDATE featured_posts SET emailed=?2 WHERE id=?1").bind(row.id, emailed ? 1 : 0).run().catch(() => {});

  // Record the dedup row LAST (finding #4): if anything above threw, the event was never marked seen, so
  // LlamaPay's retry re-drives it (no permanent drop). A genuine replay short-circuits at the top.
  await markProcessed();
  return { kind: "live", orderId, alreadyLive: false };
}

export interface FeaturedStatus {
  status: "reserving" | "live" | "expired" | "orphaned" | "blocked" | "unknown";
  paidButUnfeatured?: boolean; // true on 'orphaned' — paid but the board was full (refund/comp pending)
  emailSent?: boolean; // whether the TR-100 receipt email actually sent (finding #7)
  receipt?: ReceiptInput;
  receiptHtml?: string;
}

/** Read a poster's order status (the site polls this). Receipt present once the row is live. */
export async function getFeaturedStatus(env: Env, orderId: string): Promise<FeaturedStatus> {
  const row = await env.DB
    .prepare("SELECT id, status, author_kind, author_ref, public_summary, payment_ref, paid_at, expires_at, charge_hosted_url, order_id, emailed FROM featured_posts WHERE order_id=?1")
    .bind(orderId)
    .first<{ id: number; status: string; author_kind: string; author_ref: string | null; public_summary: string; payment_ref: string | null; paid_at: string | null; expires_at: string | null; charge_hosted_url: string | null; order_id: string; emailed: number | null }>();
  if (!row) return { status: "unknown" };
  const status = (["reserving", "live", "expired", "orphaned", "blocked"].includes(row.status) ? row.status : "unknown") as FeaturedStatus["status"];
  const emailSent = Number(row.emailed ?? 0) === 1;
  // Orphaned = paid but unfeaturable (board full at webhook time) — surface paidButUnfeatured so the
  // site can show "paid, slot pending refund/comp" instead of a misleading "expired". No public receipt.
  if (status === "orphaned") return { status, paidButUnfeatured: true, emailSent };
  if (status !== "live") return { status, emailSent };
  const db = makeDb(env.DB);
  const cap = Math.trunc(Number(await getSetting(db, "featured_daily_cap", String(DEFAULT_CAP)))) || DEFAULT_CAP;
  const priceUsd = await featuredPriceUsd(db);
  const built = await buildReceiptForRow(env, row, cap, priceUsd);
  return { status, emailSent, receipt: built.receipt, receiptHtml: built.html };
}

/* ─────────────────────────────── HUMAN path routes (PUBLIC — above the access gate) ───────────── */

featuredRoutes.post("/featured/reserve", async (c) => {
  const parsed = reserveSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ ok: false, error: "authorKind:'human', publicSummary, email, and over18:true required", details: parsed.error.flatten() }, 400);
  }
  // The human path is dark (503) until the LlamaPay key is set — never a 403 (this is the OPEN board).
  if (!c.env.LLAMAPAY_API_KEY) return c.json({ ok: false, code: "llamapay_unconfigured" }, 503);

  const db = makeDb(c.env.DB);
  // The server generates the authoritative order id inside reserveHumanSlot (no client `ref`); the
  // cf-connecting-ip scopes the anti-squatting control + the per-poster chaperone callerRef.
  const r = await reserveHumanSlot(db, c.env, parsed.data, c.req.header("cf-connecting-ip"));
  switch (r.kind) {
    case "full":
      return c.json({ ok: false, error: "the window is full — all featured slots are taken; try again later", capReached: true }, 409);
    case "blocked":
      return c.json({ ok: false, blocked: true, reason: r.reason }, 422);
    case "squatting":
      // An outstanding unpaid reservation already held by this IP → 429 (finding #6). Pay or wait for it
      // to expire, then reserve again.
      return c.json({ ok: false, error: r.reason, squatting: true }, 429);
    case "charge_failed":
      return c.json({ ok: false, error: "could not start checkout", reason: r.reason }, 502);
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
