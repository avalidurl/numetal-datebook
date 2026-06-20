/**
 * Automated human-escalation tier (replaces the concierge brokering once configured).
 * Flow: both agents recommend → /escalations/:id/invite (one-time links) → /escalations/claim
 * (Privy profile claim) → /identity/session (Didit) → /identity/webhook/didit (result) →
 * when BOTH owners are identity_verified AND both consented → reveal_ready. Privy/Didit are
 * no-op until configured (routes return 503), so this ships safely before the accounts exist.
 */
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db as makeDb, type DB } from "../db/client";
import { couples, escalationInvites, events, identityVerifications, introConsents, owners, personas } from "../db/schema";
import type { Env } from "../env";
import { createDiditSession } from "../identity/didit";
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

// Issue one-time claim links for both owners of a couple (founder/agent triggered).
identityRoutes.post("/escalations/:coupleId/invite", async (c) => {
  const coupleId = Number(c.req.param("coupleId"));
  if (!Number.isInteger(coupleId) || coupleId <= 0) return c.json({ error: "bad couple id" }, 400);
  const db = makeDb(c.env.DB);
  const ids = await coupleOwnerIds(db, coupleId);
  if (ids.length < 2) return c.json({ error: "couple/owners not found" }, 404);
  const invites: Array<{ ownerId: number; token: string }> = [];
  for (const ownerId of ids) {
    const token = crypto.randomUUID();
    await db.insert(escalationInvites).values({ coupleId, ownerId, token, status: "sent" }).run();
    invites.push({ ownerId, token });
  }
  return c.json({ ok: true, invites }); // tokens become claim links: /escalations/claim
});

const claimSchema = z.object({ token: z.string().min(8), privyToken: z.string().min(8) });

identityRoutes.post("/escalations/claim", async (c) => {
  const parsed = claimSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "token + privyToken required" }, 400);
  const db = makeDb(c.env.DB);
  const invite = await db.select().from(escalationInvites).where(eq(escalationInvites.token, parsed.data.token)).get();
  if (!invite || invite.status !== "sent") return c.json({ error: "invalid or used invite" }, 404);

  const privy = await verifyPrivyToken(c.env, parsed.data.privyToken);
  if (!privy.ok) return c.json({ error: "privy verification failed", reason: privy.reason }, privy.reason === "privy not configured" ? 503 : 401);

  await db.update(owners).set({ tier: "profile_claimed", updatedAt: new Date().toISOString() }).where(eq(owners.id, invite.ownerId)).run();
  await db.update(escalationInvites).set({ status: "claimed", claimedAt: new Date().toISOString() }).where(eq(escalationInvites.id, invite.id)).run();
  return c.json({ ok: true, ownerId: invite.ownerId, tier: "profile_claimed" });
});

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

identityRoutes.post("/identity/webhook/didit", async (c) => {
  const raw = await c.req.text();
  const { verifyDiditWebhook } = await import("../identity/didit");
  const w = await verifyDiditWebhook(c.env, raw, c.req.header("x-signature"));
  if (!w.ok) return c.json({ error: "webhook rejected", reason: w.reason }, w.reason === "didit webhook not configured" ? 503 : 400);
  const db = makeDb(c.env.DB);
  const iv = w.sessionId
    ? await db.select().from(identityVerifications).where(eq(identityVerifications.sessionId, w.sessionId)).get()
    : undefined;
  if (!iv) return c.json({ error: "unknown session" }, 404);
  await db
    .update(identityVerifications)
    .set({ status: w.status, ageOver18: w.ageOver18 ? 1 : 0, updatedAt: new Date().toISOString() })
    .where(eq(identityVerifications.id, iv.id))
    .run();
  if (w.status === "verified" && w.ageOver18) {
    await db.update(owners).set({ tier: "identity_verified", updatedAt: new Date().toISOString() }).where(eq(owners.id, iv.ownerId)).run();
  }
  return c.json({ ok: true });
});

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
