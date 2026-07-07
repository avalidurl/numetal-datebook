/**
 * Automated human-escalation tier (replaces the concierge brokering once configured).
 * Flow: both agents recommend → /escalations/:id/invite (one-time links) → /escalations/claim
 * (Privy profile claim) → /identity/session (Didit) → /identity/webhook/didit (result) →
 * when BOTH owners are identity_verified AND both consented → reveal_ready. Privy/Didit are
 * no-op until configured (routes return 503), so this ships safely before the accounts exist.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { db as makeDb, type DB } from "../db/client";
import { couples, escalationInvites, events, identityVerifications, introConsents, owners, personas, revealPayments } from "../db/schema";
import type { Env } from "../env";
import { open } from "../crypto/box";
import { SKUS, makeX402Provider, parsePaymentHeader, x402Challenge } from "../payments/x402";
import { readPaymentRails, settlementNetwork, verifyPushRailFailClosed } from "../payments/dual-rail";
import { mppProblem } from "../payments/mpp";
import { createDiditSession, verifyDiditWebhook } from "../identity/didit";
import { verifyPrivyToken } from "../identity/privy";
import { claimShell } from "../ui/system-pages";

export const identityRoutes = new Hono<{ Bindings: Env }>();

export async function coupleOwnerIds(db: DB, coupleId: number): Promise<number[]> {
  const couple = await db.select().from(couples).where(eq(couples.id, coupleId)).get();
  if (!couple) return [];
  const rows = await db
    .select({ ownerId: personas.ownerId })
    .from(personas)
    .where(inArray(personas.id, [couple.aId, couple.bId]))
    .all();
  return rows.map((r) => r.ownerId).filter((x): x is number => x != null);
}

/** reveal_ready = both owners identity_verified AND both consented (contact_reveal). */
export async function revealReady(db: DB, coupleId: number): Promise<boolean> {
  const ids = await coupleOwnerIds(db, coupleId);
  if (ids.length < 2) return false;
  const verified = await db.select({ id: owners.id }).from(owners).where(and(inArray(owners.id, ids), eq(owners.tier, "identity_verified"))).all();
  if (verified.length < ids.length) return false;
  // H1: tier alone is not enough — require a recorded 18+ result for BOTH owners. A provider that
  // reported verified-but-not-adult must NEVER reach contact reveal. The age flag is the gate.
  // SEC-2026-07-01(#6): the ageOver18=1 row MUST also be status='verified'. Without the status
  // predicate a stale/declined/expired verification that happened to carry ageOver18=1 would satisfy
  // the adult gate, letting an owner whose CURRENT verification is not adult (or not verified) reach
  // contact reveal. Binding age to a verified row closes the minor-safety hole.
  const adult = await db
    .select({ ownerId: identityVerifications.ownerId })
    .from(identityVerifications)
    .where(
      and(
        inArray(identityVerifications.ownerId, ids),
        eq(identityVerifications.status, "verified"),
        eq(identityVerifications.ageOver18, 1),
      ),
    )
    .all();
  const adultSet = new Set(adult.map((a) => a.ownerId));
  if (!ids.every((i) => adultSet.has(i))) return false;
  const consents = await db
    .select({ ownerId: introConsents.ownerId })
    .from(introConsents)
    .where(and(eq(introConsents.coupleId, coupleId), eq(introConsents.consentKind, "contact_reveal"), eq(introConsents.status, "accepted")))
    .all();
  const consented = new Set(consents.map((c) => c.ownerId));
  return ids.every((i) => consented.has(i));
}

async function maybeFireReveal(db: DB, coupleId: number): Promise<boolean> {
  if (!(await revealReady(db, coupleId))) return false;
  await db.insert(events).values({ kind: "milestone", payload: JSON.stringify({ reveal_ready: coupleId }) }).run();
  return true;
}

// Issue one-time claim links for both owners of a couple (redacted).
identityRoutes.post("/escalations/:coupleId/invite", async (c) => {
  const coupleId = Number(c.req.param("coupleId"));
  if (!Number.isInteger(coupleId) || coupleId <= 0) return c.json({ error: "bad couple id" }, 400);
  const db = makeDb(c.env.DB);
  const ids = await coupleOwnerIds(db, coupleId);
  if (ids.length < 2) return c.json({ error: "couple/owners not found" }, 404);
  // High-entropy (256-bit) one-time token + a 72h expiry. The token is bound to ONE owner,
  // consumed once, and on claim further bound to the Privy identity that redeemed it — so a
  // leaked link can't walk toward a contact reveal indefinitely (committee security finding).
  const expiresAt = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
  const invites: Array<{ ownerId: number; token: string }> = [];
  for (const ownerId of ids) {
    const token = [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, "0")).join("");
    await db.insert(escalationInvites).values({ coupleId, ownerId, token, status: "sent", expiresAt }).run();
    invites.push({ ownerId, token });
  }
  return c.json({ ok: true, invites, expiresAt }); // tokens become claim links: /escalations/claim
});

const claimSchema = z.object({ token: z.string().min(8), privyToken: z.string().min(8) });

/**
 * PUBLIC claim handler (registered pre-access-gate in index.ts). Authenticated by the
 * one-time invite token + a verified Privy login — NOT the founder ACCESS_KEY (the human
 * dater's owner can't have it). On success: owner → profile_claimed, invite consumed, and
 * a Didit identity session is started; returns the Didit URL to redirect the human to.
 */
export async function claimHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const parsed = claimSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "token + privyToken required" }, 400);
  const db = makeDb(c.env.DB);
  const invite = await db.select().from(escalationInvites).where(eq(escalationInvites.token, parsed.data.token)).get();
  if (!invite || invite.status !== "sent") return c.json({ error: "invalid or used invite" }, 404);
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
    await db.update(escalationInvites).set({ status: "expired" }).where(eq(escalationInvites.id, invite.id)).run();
    return c.json({ error: "invite expired" }, 410);
  }

  const privy = await verifyPrivyToken(c.env, parsed.data.privyToken);
  if (!privy.ok) return c.json({ error: "privy verification failed", reason: privy.reason }, privy.reason === "privy not configured" ? 503 : 401);

  await db.update(owners).set({ tier: "profile_claimed", updatedAt: new Date().toISOString() }).where(eq(owners.id, invite.ownerId)).run();
  // Bind the consumed token to the Privy identity that redeemed it (one-time + identity-bound).
  await db.update(escalationInvites).set({ status: "claimed", claimedAt: new Date().toISOString(), claimedBy: privy.userId ?? null }).where(eq(escalationInvites.id, invite.id)).run();

  // Start the binding 18+/ID check (Didit) bound to this owner+couple, and return the hosted URL so
  // the human is redirected straight into it. Didit's signed webhook promotes the owner on approval.
  // If Didit isn't configured, the claim still succeeds (profile_claimed) — never a dead end.
  const didit = await createDiditSession(c.env, {
    ownerId: invite.ownerId,
    coupleId: invite.coupleId,
    callbackUrl: `${new URL(c.req.url).origin}/api/identity/webhook/didit`,
  });
  if (didit.ok && didit.sessionId) {
    await db
      .insert(identityVerifications)
      .values({ ownerId: invite.ownerId, provider: "didit", sessionId: didit.sessionId, status: "pending" })
      .run();
  }
  return c.json({
    ok: true,
    ownerId: invite.ownerId,
    tier: "profile_claimed",
    diditUrl: didit.ok ? (didit.url ?? null) : null,
    diditReason: didit.ok ? undefined : didit.reason,
  });
}

const revealSchema = z.object({ privyToken: z.string().min(8) });

/**
 * PUBLIC automated bilateral reveal (registered pre-access-gate). The Privy identity that CLAIMED an
 * invite is the ONLY one who can reveal, and ONLY its own couple's OTHER contact, and ONLY after every
 * gate (both identity_verified + both ageOver18 + both consented — `revealReady`). Every reveal/decrypt
 * is audited. Until Didit verifies BOTH (e.g. while Didit is unfunded), `revealReady` is false → the
 * human is told the introduction opens soon (the soft-launch hold).
 */
export async function revealHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const parsed = revealSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "privyToken required" }, 400);
  const privy = await verifyPrivyToken(c.env, parsed.data.privyToken);
  if (!privy.ok || !privy.userId)
    return c.json({ error: "privy verification failed", reason: privy.reason }, privy.reason === "privy not configured" ? 503 : 401);
  const db = makeDb(c.env.DB);
  // Bind the reveal to the Privy identity that consumed the invite — its couple only (no IDOR).
  const inv = await db
    .select({ ownerId: escalationInvites.ownerId, coupleId: escalationInvites.coupleId })
    .from(escalationInvites)
    .where(and(eq(escalationInvites.claimedBy, privy.userId), eq(escalationInvites.status, "claimed")))
    .orderBy(desc(escalationInvites.id))
    .get();
  if (!inv) return c.json({ error: "no claimed introduction for this identity" }, 404);
  if (!(await revealReady(db, inv.coupleId)))
    return c.json({ ok: true, ready: false, status: "Your 18+ check is still pending — we'll open the introduction the moment it clears." });
  // Paywall: EACH side pays $20 (x402/USDC) once to unlock its own reveal. We only charge here —
  // after the intro is actually revealable — so no one pays before there's a contact to unlock. A
  // side that already paid re-reveals free. Charged downstream of the 18+/consent gate, so this is
  // dormant until reveals go live. PAY_TO unset → payments off → reveal stays free (backward compatible).
  if (c.env.PAY_TO) {
    const alreadyPaid = await db
      .select({ id: revealPayments.id })
      .from(revealPayments)
      .where(and(eq(revealPayments.coupleId, inv.coupleId), eq(revealPayments.ownerId, inv.ownerId)))
      .get();
    if (!alreadyPaid) {
      const sku = SKUS.reveal_unlock!;
      const rails = readPaymentRails(c.env, sku, {
        paymentSignature: c.req.header("payment-signature"),
        xPayment: c.req.header("x-payment"),
        authorization: c.req.header("authorization"),
      });
      if (!rails.hasPayment) return x402Challenge(c.env, sku, c.env.PAY_TO, `reveal:${inv.coupleId}:${inv.ownerId}`);
      const provider = makeX402Provider(c.env);
      const orderId = rails.isMpp
        ? `reveal:${inv.coupleId}:${inv.ownerId}:mpp:${rails.mppCred!.challenge.id ?? "noid"}`
        : `reveal:${inv.coupleId}:${inv.ownerId}:${parsePaymentHeader(rails.paymentHeader!)?.nonce ?? "nononce"}`;
      if (!rails.isMpp) {
        const prior = await db.select({ id: revealPayments.id }).from(revealPayments).where(eq(revealPayments.orderId, orderId)).get();
        if (prior) return c.json({ error: "this payment authorization was already used — sign a new one" }, 409);
      }
      const verified = await verifyPushRailFailClosed(c.env, sku, c.env.PAY_TO, rails, provider);
      if ("mppResponse" in verified) return verified.mppResponse;
      const v = verified.v;
      if (!v.verified || !v.payer) return x402Challenge(c.env, sku, c.env.PAY_TO, `reveal:${inv.coupleId}:${inv.ownerId}`);
      if (rails.isMpp) {
        const prior = await db.select({ id: revealPayments.id }).from(revealPayments).where(eq(revealPayments.orderId, orderId)).get();
        if (prior) return mppProblem(c.env, sku, "invalid-challenge", "this payment was already redeemed — request a new challenge");
      }
      // First insert wins; the (couple, owner) unique index makes a concurrent double-pay a no-op.
      await db
        .insert(revealPayments)
        .values({
          orderId,
          coupleId: inv.coupleId,
          ownerId: inv.ownerId,
          payer: v.payer.toLowerCase(),
          amountUsdc: v.amountUsdc ?? sku.priceUsd.replace("$", ""),
          network: settlementNetwork(rails.isMpp, provider),
          nonce: v.nonce,
          settlementTx: v.tx,
        })
        .onConflictDoNothing()
        .run();
    }
  }
  const ids = await coupleOwnerIds(db, inv.coupleId);
  const otherId = ids.find((id) => id !== inv.ownerId);
  if (otherId == null) return c.json({ error: "introduction incomplete" }, 404);
  const other = await db.select({ displayName: owners.displayName, contactRef: owners.contactRef }).from(owners).where(eq(owners.id, otherId)).get();
  const contact = (await open(c.env, other?.contactRef ?? null)) ?? null;
  // Audit every reveal + decrypt (accountability + stalking deterrent).
  await db
    .insert(events)
    .values({ kind: "contact_revealed", payload: JSON.stringify({ coupleId: inv.coupleId, toOwner: inv.ownerId, otherOwner: otherId, at: new Date().toISOString() }) })
    .run();
  return c.json({ ok: true, ready: true, match: { name: other?.displayName ?? "your match", contact } });
}

/** PUBLIC claim page (GET /claim?token=…) — minimal Privy login, then POST to /api/escalations/claim
 *  and redirect to the Didit identity flow. Served by the Worker so there's no separate frontend.
 *  NOTE: the Privy client calls need a browser smoke test against the live app before go-live. */
export function claimPage(c: Context<{ Bindings: Env }>): Response {
  if (!c.env.PRIVY_APP_ID) {
    return c.html(
      claimShell({
        title: "Ishtar · confirm your intro",
        docline: "Doc · ISH-00 · Confirm intro · Rev 0.1",
        partno: "Part No. ISH-101 — introduction claim",
        tagline: "Sign-in isn't open yet.",
        subHtml:
          "The introduction desk isn't configured on this venue yet. Check back shortly — your invite link stays valid until it expires.",
        bodyHtml: `<div class="actions"><a class="btn" href="https://ishtar.numetal.xyz/docs/humans/getting-an-intro">How intros work &#8599;</a></div>`,
      }),
      503,
    );
  }
  const appId = c.env.PRIVY_APP_ID.replace(/[^A-Za-z0-9_-]/g, ""); // sanitize before HTML injection
  // The "Sign in to confirm" button lives in STATIC HTML and is ALWAYS visible (disabled until
  // Privy is ready). Privy mounts into a hidden 1px node purely to drive its hook; if Privy never
  // readies (origin not allow-listed) or esm.sh fails, the button flips to a Reload action — never
  // a blank, button-less page (the original bug). The confirm flow is unchanged.
  const bodyHtml = `<div class="actions" style="margin-top:1.6rem">
      <button id="signin" class="btn primary" disabled>&#9670; Sign in to confirm</button>
    </div>
    <p id="msg" class="sub" style="min-height:1.3em;margin-top:.9rem">Initialising sign-in&hellip;</p>
    <div id="relay-container" style="margin-top:1.2rem"></div>
    <div id="app" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden"></div>`;
  const headHtml = `<script>window.__PRIVY_APP_ID__=${JSON.stringify(appId)};</script>
<script src="/claim.js" defer></script>`;
  return c.html(
    claimShell({
      title: "Ishtar · confirm your intro",
      docline: "Doc · ISH-00 · Confirm intro · Rev 0.1",
      partno: "Part No. ISH-101 — introduction claim",
      tagline: "Your agent found someone.",
      subHtml:
        "Sign in to confirm you'd like the introduction. After you confirm, there's a quick binding 18+ identity check; contact is revealed only when both sides have confirmed.",
      bodyHtml,
      headHtml,
    }),
  );
}

const sessionSchema = z.object({ ownerId: z.number().int().positive(), coupleId: z.number().int().positive().optional() });

identityRoutes.post("/identity/session", async (c) => {
  const parsed = sessionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "ownerId required" }, 400);
  const db = makeDb(c.env.DB);
  const owner = await db.select().from(owners).where(eq(owners.id, parsed.data.ownerId)).get();
  if (!owner) return c.json({ error: "no such owner" }, 404);
  if (owner.tier !== "profile_claimed" && owner.tier !== "identity_verified") {
    return c.json({ error: "owner must claim a profile (Privy) before identity check" }, 403);
  }
  const s = await createDiditSession(c.env, { ownerId: parsed.data.ownerId, coupleId: parsed.data.coupleId, callbackUrl: `${new URL(c.req.url).origin}/api/identity/webhook/didit` });
  if (!s.ok) return c.json({ error: "identity provider unavailable", reason: s.reason }, 503);
  await db.insert(identityVerifications).values({ ownerId: parsed.data.ownerId, provider: "didit", sessionId: s.sessionId, status: "pending" }).run();
  return c.json({ ok: true, url: s.url, sessionId: s.sessionId });
});

/**
 * Didit webhook handler — registered in index.ts BEFORE the access gate (Didit can't send
 * our ACCESS_KEY; it authenticates by HMAC + timestamp instead). Returns 2xx fast; work is
 * idempotent so retried/duplicate deliveries are harmless.
 */
export async function diditWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const raw = await c.req.text();
  const w = await verifyDiditWebhook(c.env, raw, c.req.header("x-signature"), c.req.header("x-timestamp"));
  if (!w.ok) {
    // Log the raw body for signature debugging (never re-stringify after parse).
    console.warn("didit webhook rejected:", w.reason, raw.slice(0, 500));
    return c.json({ error: "webhook rejected", reason: w.reason }, w.reason === "didit webhook not configured" ? 503 : 400);
  }
  // Only act on session status changes; ack everything else (data/user/business/activity/txn).
  if (w.webhookType && w.webhookType !== "status.updated") return c.json({ ok: true, ignored: w.webhookType });

  const db = makeDb(c.env.DB);
  const ownerId = w.vendorData ? Number(w.vendorData) : undefined;
  // Map result → IV row by session id, else by vendor_data (ownerId). Same shape both ways.
  const cols = { id: identityVerifications.id, ownerId: identityVerifications.ownerId };
  let target = w.sessionId
    ? await db.select(cols).from(identityVerifications).where(eq(identityVerifications.sessionId, w.sessionId)).get()
    : undefined;
  if (!target && ownerId) {
    target = await db
      .insert(identityVerifications)
      .values({ ownerId, provider: "didit", sessionId: w.sessionId, status: "pending" })
      .returning(cols)
      .get();
  }
  if (!target) return c.json({ ok: true, note: "no matching session/vendor_data" });

  await db
    .update(identityVerifications)
    .set({ status: w.verified ? "verified" : "failed", ageOver18: w.ageOver18 ? 1 : 0, updatedAt: new Date().toISOString() })
    .where(eq(identityVerifications.id, target.id))
    .run();
  if (w.verified) {
    await db.update(owners).set({ tier: "identity_verified", updatedAt: new Date().toISOString() }).where(eq(owners.id, target.ownerId)).run();
  }
  return c.json({ ok: true });
}

identityRoutes.get("/escalations/:coupleId/status", async (c) => {
  const coupleId = Number(c.req.param("coupleId"));
  if (!Number.isInteger(coupleId) || coupleId <= 0) return c.json({ error: "bad couple id" }, 400);
  const db = makeDb(c.env.DB);
  const ids = await coupleOwnerIds(db, coupleId);
  if (ids.length < 2) return c.json({ error: "couple/owners not found" }, 404);
  const tiers = await db.select({ id: owners.id, tier: owners.tier }).from(owners).where(inArray(owners.id, ids)).all();
  const ready = await maybeFireReveal(db, coupleId);
  return c.json({ coupleId, owners: tiers, reveal_ready: ready });
});
