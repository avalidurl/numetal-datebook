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
import { SKUS, makeX402Provider, x402Challenge, type PaymentProvider } from "../payments/x402";
import type { Env } from "../env";

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
    const claim = await env.DB
      .prepare(
        `INSERT INTO featured_posts (author_kind, author_ref, public_summary, reveal_fields, order_id, status)
         SELECT ?1, ?2, ?3, ?4, ?5, 'reserving'
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
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  const publishedSummary = verdict.text ?? input.publicSummary;
  const flip = await env.DB
    .prepare("UPDATE featured_posts SET status='live', payer=?2, expires_at=?3, public_summary=?4 WHERE id=?1 AND status='reserving'")
    .bind(postId, v.payer.toLowerCase(), expiresAt, publishedSummary)
    .run();
  if ((flip.meta.changes ?? 0) === 1) {
    await attest18(db, v.payer); // over18 confirmed at the route → recorded (defensible adults-only record)
    await accrueBuyback(db, env, null, Number(sku.priceUsd.replace("$", ""))); // no premium_orders row → null ref
  }
  return { kind: "live", id: postId, expiresAt, payer: v.payer.toLowerCase(), tx: v.tx };
}

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
