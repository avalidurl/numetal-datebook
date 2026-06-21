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
import { verifyPrivyToken } from "../identity/privy";

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

/** PUBLIC claim page (GET /claim?token=…) — minimal Privy login, then POST to /api/escalations/claim
 *  and redirect to the Didit identity flow. Served by the Worker so there's no separate frontend.
 *  NOTE: the Privy client calls need a browser smoke test against the live app before go-live. */
export function claimPage(c: Context<{ Bindings: Env }>): Response {
  if (!c.env.PRIVY_APP_ID) {
    return c.html("<!doctype html><meta charset=utf-8><title>datebook</title><body style='font-family:ui-monospace,monospace;max-width:520px;margin:3rem auto'><h1>datebook</h1><p>Sign-in isn't configured yet — check back soon.</p></body>", 503);
  }
  const appId = c.env.PRIVY_APP_ID.replace(/[^A-Za-z0-9_-]/g, ""); // sanitize before HTML injection
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>datebook · confirm your intro</title>
<body style="font-family:ui-monospace,monospace;max-width:520px;margin:3rem auto;padding:0 1rem">
<h1 style="font-weight:600">datebook</h1>
<p>Your agent found someone. Sign in to confirm you'd like the introduction.</p>
<div id="app"><p>Loading…</p></div>
<p id="msg" style="opacity:.7;margin-top:1rem"></p>
<script type="module">
import React from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import { PrivyProvider, usePrivy } from "https://esm.sh/@privy-io/react-auth@2?deps=react@18.3.1,react-dom@18.3.1";
import htm from "https://esm.sh/htm@3.1.1";
const html = htm.bind(React.createElement);
const APP_ID = "${appId}";
const TOKEN = new URLSearchParams(location.search).get("token") || "";
const setMsg = (t) => { document.getElementById("msg").textContent = t; };
function Claim() {
  const { ready, authenticated, login, getAccessToken } = usePrivy();
  React.useEffect(() => { (async () => {
    if (!ready || !authenticated) return;
    setMsg("Confirming…");
    try {
      const privyToken = await getAccessToken();
      const r = await fetch("/api/escalations/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN, privyToken }) });
      const j = await r.json();
      if (j.ok) { setMsg("Confirmed. Next: a quick identity check…"); if (j.diditUrl) location.href = j.diditUrl; else setMsg("Confirmed — identity step will follow shortly."); }
      else setMsg("Could not confirm: " + (j.reason || j.error || r.status));
    } catch (e) { setMsg("Error: " + e.message); }
  })(); }, [ready, authenticated]);
  if (!ready) return html\`<p>Loading…</p>\`;
  if (!authenticated) return html\`<button onClick=\${login} style="padding:.7rem 1.2rem;font:inherit;cursor:pointer">Sign in to confirm</button>\`;
  return html\`<p>Signed in ✓</p>\`;
}
createRoot(document.getElementById("app")).render(html\`<\${PrivyProvider} appId=\${APP_ID}><\${Claim} /></\${PrivyProvider}>\`);
</script>
</body>`;
  return c.html(html);
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
