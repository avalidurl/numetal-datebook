/**
 * Self-serve "nuke it" — an owner revokes their connection(s) on demand, authed by the SAME per-owner
 * magic-link token they use for GET /api/matches (verifyMatchToken), NOT the founder ACCESS_KEY. Public,
 * mounted ABOVE the access gate. Two scopes:
 *   - "connection" (default): withdraw contact-reveal consent (status→'declined') + end the couple(s)
 *     (state→'ended'). Effect: revealReady() flips false, so the OTHER side can no longer fetch the
 *     contact, and the connection is dissolved. Targets one coupleId or ALL the owner's active couples.
 *   - "account": the full GDPR eraseOwner cascade (nulls contact, drops vectors, deletes owner rows,
 *     and — via the erasure fix — ends the couples too).
 *
 * HARD LIMIT (returned in the response + audited): a contact ALREADY revealed to and saved by the other
 * party before the nuke CANNOT be clawed back — it lives on their device/agent, outside Ishtar. Revoke
 * blocks FUTURE access; it cannot un-ring the bell. This is stated plainly so the owner isn't misled.
 */
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db as makeDb } from "../db/client";
import { couples, events, introConsents, personas } from "../db/schema";
import type { Env } from "../env";
import { verifyMatchToken } from "../crypto/matchtoken";
import { eraseOwner } from "../erasure";

export const connectionRoutes = new Hono<{ Bindings: Env }>();

const HARD_LIMIT_NOTICE =
  "Revoked. Going forward the other side can no longer see your contact through Ishtar. " +
  "NOTE: any contact already revealed to them before now cannot be recalled — it may live on their " +
  "device or agent, outside Ishtar. Revoke blocks future access; it cannot un-send what was already shared.";

const schema = z.object({
  token: z.string().min(1),
  scope: z.enum(["connection", "account"]).default("connection"),
  coupleId: z.number().int().positive().optional(), // omit → all the owner's active couples
});

connectionRoutes.post("/connection/revoke", async (c) => {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "token required" }, 400);
  const { token, scope, coupleId } = parsed.data;

  // Auth: the per-owner magic-link token (same one that reads /api/matches) → ownerId. Not the founder key.
  const v = await verifyMatchToken(c.env, token);
  if (!v.ok) {
    if (v.reason === "unconfigured") return c.json({ error: "revoke is not enabled on this venue yet" }, 503);
    const expired = v.reason === "expired";
    return c.json({ error: expired ? "this link has expired" : "invalid link", expired }, 401);
  }
  const ownerId = v.ownerId;
  const db = makeDb(c.env.DB);

  if (scope === "account") {
    // Full GDPR nuke (eraseOwner also ends the owner's couples via the erasure fix).
    await eraseOwner(db, c.env, ownerId);
    await db
      .insert(events)
      .values({ kind: "connection_revoked", payload: JSON.stringify({ ownerId, scope: "account", at: new Date().toISOString() }) })
      .run();
    return c.json({ ok: true, scope: "account", erased: true, notice: HARD_LIMIT_NOTICE });
  }

  // scope === "connection": find the owner's active couples (all, or the named one IF the owner is in it).
  const ownerPersonas = await db.select({ id: personas.id }).from(personas).where(eq(personas.ownerId, ownerId)).all();
  const pids = new Set(ownerPersonas.map((p) => p.id));
  let revoked = 0;
  if (pids.size) {
    const all = await db.select({ id: couples.id, aId: couples.aId, bId: couples.bId, state: couples.state }).from(couples).all();
    const mine = all.filter(
      (r) => (pids.has(r.aId) || pids.has(r.bId)) && r.state !== "ended" && (coupleId ? r.id === coupleId : true),
    );
    const nowIso = new Date().toISOString();
    for (const cp of mine) {
      // Withdraw THIS owner's contact-reveal consent → revealReady() requires BOTH accepted, so it flips false.
      await db
        .update(introConsents)
        .set({ status: "declined", decidedAt: nowIso })
        .where(and(eq(introConsents.coupleId, cp.id), eq(introConsents.ownerId, ownerId), eq(introConsents.consentKind, "contact_reveal")))
        .run();
      // Dissolve the connection.
      await db.update(couples).set({ state: "ended" }).where(eq(couples.id, cp.id)).run();
      revoked++;
    }
  }
  await db
    .insert(events)
    .values({ kind: "connection_revoked", payload: JSON.stringify({ ownerId, scope: "connection", couplesEnded: revoked, at: new Date().toISOString() }) })
    .run();
  return c.json({ ok: true, scope: "connection", couplesEnded: revoked, notice: HARD_LIMIT_NOTICE });
});
