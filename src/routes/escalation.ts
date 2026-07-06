/**
 * Concierge escalation (humans-meet-now, founder-brokered). When BOTH owners of a couple
 * record contact-reveal consent, the couple flips to `committed` and an intro_ready
 * milestone fires — surfacing on the access-gated /admin "intros to broker" view with the
 * two private contact_refs. No Privy/Didit yet (that's the parallel automated tier); the
 * founder personally makes the first intros. Consent is idempotent per (couple, owner).
 */
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db as makeDb } from "../db/client";
import { couples, events, introConsents, personas } from "../db/schema";
import type { Env } from "../env";

export const escalationRoutes = new Hono<{ Bindings: Env }>();

const schema = z.object({ ownerId: z.number().int().positive() });

escalationRoutes.post("/couples/:id/intro-consent", async (c) => {
  const coupleId = Number(c.req.param("id"));
  if (!Number.isInteger(coupleId) || coupleId <= 0) return c.json({ error: "bad couple id" }, 400);
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "ownerId required" }, 400);
  const { ownerId } = parsed.data;
  const db = makeDb(c.env.DB);

  const couple = await db.select().from(couples).where(eq(couples.id, coupleId)).get();
  if (!couple) return c.json({ error: "no such couple" }, 404);

  // ownerId must own one of the two personas in this couple.
  const rows = await db
    .select({ ownerId: personas.ownerId })
    .from(personas)
    .where(inArray(personas.id, [couple.aId, couple.bId]))
    .all();
  const coupleOwners = rows.map((r) => r.ownerId).filter((x): x is number => x != null);
  if (!coupleOwners.includes(ownerId)) return c.json({ error: "owner not in this couple" }, 403);

  const nowIso = new Date().toISOString();
  await db
    .insert(introConsents)
    .values({ coupleId, ownerId, consentKind: "contact_reveal", status: "accepted", decidedAt: nowIso })
    .onConflictDoUpdate({
      target: [introConsents.coupleId, introConsents.ownerId, introConsents.consentKind],
      set: { status: "accepted", decidedAt: nowIso },
    })
    .run();

  const accepted = await db
    .select({ ownerId: introConsents.ownerId })
    .from(introConsents)
    .where(
      and(
        eq(introConsents.coupleId, coupleId),
        eq(introConsents.consentKind, "contact_reveal"),
        eq(introConsents.status, "accepted"),
      ),
    )
    .all();
  const consented = new Set(accepted.map((a) => a.ownerId));
  const both = coupleOwners.length >= 2 && coupleOwners.every((o) => consented.has(o));

  if (both && couple.state !== "committed") {
    await db.update(couples).set({ state: "committed", commitSource: "human_consent" }).where(eq(couples.id, coupleId)).run();
    await db
      .insert(events)
      .values({ kind: "milestone", payload: JSON.stringify({ intro_ready: coupleId }) })
      .run();
  }
  return c.json({ consented: true, both });
});
