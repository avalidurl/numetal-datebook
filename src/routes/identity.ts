/**
 * Automated human-escalation tier (replaces the concierge brokering once configured).
 * Flow: both agents recommend → /escalations/:id/invite (one-time links) → /escalations/claim
 * (Privy profile claim) → /identity/session (Didit) → /identity/webhook/didit (result) →
 * when BOTH owners are identity_verified AND both consented → reveal_ready. Privy/Didit are
 * no-op until configured (routes return 503), so this ships safely before the accounts exist.
 */
import { and, eq, inArray } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { db as makeDb, type DB } from "../db/client";
import { couples, escalationInvites, events, identityVerifications, introConsents, owners, personas } from "../db/schema";
import type { Env } from "../env";
import { createDiditSession, verifyDiditWebhook } from "../identity/didit";
import { createAgeSession, redeemAgeClaim } from "../identity/persona";
import { verifyPrivyToken } from "../identity/privy";
import { claimShell } from "../ui/system-pages";

export const identityRoutes = new Hono<{ Bindings: Env }>();

async function coupleOwnerIds(db: DB, coupleId: number): Promise<number[]> {
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
async function revealReady(db: DB, coupleId: number): Promise<boolean> {
  const ids = await coupleOwnerIds(db, coupleId);
  if (ids.length < 2) return false;
  const verified = await db.select({ id: owners.id }).from(owners).where(and(inArray(owners.id, ids), eq(owners.tier, "identity_verified"))).all();
  if (verified.length < ids.length) return false;
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

  // Kick off the identity check immediately; degrade gracefully if Didit isn't configured.
  const s = await createDiditSession(c.env, { ownerId: invite.ownerId, callbackUrl: `${new URL(c.req.url).origin}/api/identity/webhook/didit` });
  if (s.ok && s.sessionId) {
    await db.insert(identityVerifications).values({ ownerId: invite.ownerId, provider: "didit", sessionId: s.sessionId, status: "pending" }).run();
  }
  return c.json({ ok: true, ownerId: invite.ownerId, tier: "profile_claimed", diditUrl: s.ok ? s.url ?? null : null, identityNote: s.ok ? undefined : s.reason });
}

/** Map a logged-in Privy user back to the owner whose intro they claimed (claimed_by = privy sub). */
async function ownerForPrivyUser(env: Env, userId?: string): Promise<number | null> {
  if (!userId) return null;
  const row = await env.DB.prepare("SELECT owner_id FROM escalation_invites WHERE claimed_by=?1 ORDER BY id DESC LIMIT 1")
    .bind(userId)
    .first<{ owner_id: number }>();
  return row?.owner_id ?? null;
}

/**
 * POST /api/age/session — start the Persona Relay 18+ check for the logged-in claimant. Public,
 * authed by the Privy token from the claim login (NOT the founder key), mapped to the owner via the
 * consumed invite. Returns the Relay widget access token.
 */
export async function ageSessionHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { privyToken } = (await c.req.json().catch(() => ({}))) as { privyToken?: string };
  if (!privyToken) return c.json({ ok: false, error: "privyToken required" }, 400);
  const privy = await verifyPrivyToken(c.env, privyToken);
  if (!privy.ok) return c.json({ ok: false, error: "privy verification failed", reason: privy.reason }, 401);
  const ownerId = await ownerForPrivyUser(c.env, privy.userId);
  if (!ownerId) return c.json({ ok: false, error: "no claimed profile for this login" }, 404);
  const s = await createAgeSession(c.env, ownerId);
  if (!s.ok) return c.json({ ok: false, error: "age check unavailable", reason: s.reason }, 503);
  return c.json({ ok: true, accessToken: s.accessToken });
}

/** POST /api/age/claim — redeem the completed Relay claim; on pass, mark the owner identity_verified. */
export async function ageClaimHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { privyToken } = (await c.req.json().catch(() => ({}))) as { privyToken?: string };
  if (!privyToken) return c.json({ ok: false, error: "privyToken required" }, 400);
  const privy = await verifyPrivyToken(c.env, privyToken);
  if (!privy.ok) return c.json({ ok: false, error: "privy verification failed", reason: privy.reason }, 401);
  const ownerId = await ownerForPrivyUser(c.env, privy.userId);
  if (!ownerId) return c.json({ ok: false, error: "no claimed profile for this login" }, 404);
  const r = await redeemAgeClaim(c.env, ownerId);
  if (!r.ok) return c.json({ ok: false, error: "could not retrieve age result", reason: r.reason }, 502);
  const passed = r.result === "passed";
  await c.env.DB.prepare("INSERT INTO identity_verifications (owner_id, provider, status, age_over_18) VALUES (?1,'persona',?2,?3)")
    .bind(ownerId, passed ? "approved" : "declined", passed ? 1 : 0)
    .run();
  if (passed) {
    await c.env.DB.prepare("UPDATE owners SET tier='identity_verified', updated_at=datetime('now') WHERE id=?1 AND tier='profile_claimed'")
      .bind(ownerId)
      .run();
  }
  return c.json({ ok: true, result: r.result });
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
