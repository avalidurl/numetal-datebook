/**
 * Agent courtship append — POST /api/couples/:id/court
 * Owner-authed (per-owner match token), chaperoned, appends one persona turn, runs shared closure check.
 * Human intro-consent commits are tagged separately and excluded from HeartElo.
 */
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db as makeDb } from "../db/client";
import { couples, personas, turns } from "../db/schema";
import type { Env } from "../env";
import { chaperone } from "../chaperone";
import { looksLikeSystemLeak } from "../chat/ishtar";
import { verifyMatchToken } from "../crypto/matchtoken";
import { egressFilter } from "../xmtp/egress";
import { assessClosure, courtshipMaxTurns, courtshipMinTurns, resolveCoupleState } from "../match/closure";
import { isCoupleMember, loadCoupleMembership } from "../premium/report-authz";
import { recordToMProbe, scoreToM, type InferredPrefs } from "../match/tom";
import { open } from "../crypto/box";

export const courtRoutes = new Hono<{ Bindings: Env }>();

const inferredSchema = z
  .object({
    gender: z.string().optional(),
    age: z.number().optional(),
    ethnicity: z.string().optional(),
    kids: z.string().optional(),
    substances: z.string().optional(),
    languages: z.array(z.string()).optional(),
    seekGenders: z.array(z.string()).optional(),
    ageMin: z.number().optional(),
    ageMax: z.number().optional(),
    seekLanguages: z.array(z.string()).optional(),
    seekEthnicities: z.array(z.string()).optional(),
    excludeSubstances: z.array(z.string()).optional(),
  })
  .optional();

const schema = z.object({
  token: z.string().min(1),
  body: z.string().min(1).max(2000),
  inferred: inferredSchema,
});

courtRoutes.post("/couples/:id/court", async (c) => {
  const coupleId = Number(c.req.param("id"));
  if (!Number.isInteger(coupleId) || coupleId <= 0) return c.json({ error: "bad couple id" }, 400);

  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "token and body required", issues: parsed.error.issues }, 400);
  const { token, body, inferred } = parsed.data;

  const v = await verifyMatchToken(c.env, token);
  if (!v.ok) {
    if (v.reason === "unconfigured") return c.json({ error: "court append is not enabled on this venue yet" }, 503);
    const expired = v.reason === "expired";
    return c.json({ error: expired ? "this link has expired" : "invalid link", expired }, 401);
  }

  const mem = await loadCoupleMembership(c.env, coupleId);
  if (!mem.couple) return c.json({ error: "no such couple" }, 404);
  if (!isCoupleMember(mem, v.ownerId)) return c.json({ error: "owner not in this couple" }, 403);

  const db = makeDb(c.env.DB);
  const couple = await db.select().from(couples).where(eq(couples.id, coupleId)).get();
  if (!couple) return c.json({ error: "no such couple" }, 404);
  if (couple.state !== "courting") return c.json({ error: `couple not courting (state=${couple.state})` }, 409);
  if (couple.turnCount >= courtshipMaxTurns(c.env)) return c.json({ maxed: true, turns: couple.turnCount }, 409);

  const myPersonaIds = [mem.couple.aId, mem.couple.bId].filter(
    (pid) => (pid === mem.couple!.aId ? mem.ownerA : mem.ownerB) === v.ownerId,
  );
  if (!myPersonaIds.length) return c.json({ error: "no persona for this owner in couple" }, 403);

  const recent = (
    await c.env.DB.prepare(
      "SELECT author_id, author_kind, turn_seq FROM turns WHERE couple_id=?1 ORDER BY turn_seq DESC LIMIT 1",
    )
      .bind(coupleId)
      .all()
  ).results as Array<{ author_id: number; author_kind: string; turn_seq: number }>;
  const last = recent[0];
  const nextId =
    last && last.author_kind === "persona"
      ? last.author_id === mem.couple.aId
        ? mem.couple.bId
        : mem.couple.aId
      : mem.couple.aId;
  const authorId = myPersonaIds.includes(nextId) ? nextId : myPersonaIds[0]!;
  if (authorId !== nextId) {
    return c.json({ error: "not your turn — wait for the other persona's line" }, 409);
  }

  const verdict = await chaperone(db, c.env, {
    stage: "pre_turn",
    targetType: "turn",
    targetId: coupleId,
    text: body,
    callerRef: `owner:${v.ownerId}`,
  });
  if (verdict.verdict !== "allow" && verdict.verdict !== "sanitize") {
    return c.json({ withheld: true, reason: verdict.reason }, 422);
  }
  const safe = verdict.text ?? body;
  if (looksLikeSystemLeak(safe) || !egressFilter(safe).safe) {
    return c.json({ withheld: true, reason: "blocked: instruction/secret disclosure" }, 422);
  }

  const maxSeq = Number(
    (await c.env.DB.prepare("SELECT coalesce(max(turn_seq),0) m FROM turns WHERE couple_id=?1").bind(coupleId).first<{ m: number }>())?.m ?? 0,
  );
  const seq = maxSeq + 1;
  await db
    .insert(turns)
    .values({ coupleId, turnSeq: seq, authorId, authorKind: "persona", body: safe, status: "published" })
    .onConflictDoNothing()
    .run();

  let state = resolveCoupleState(c.env, seq, "continue");
  let commitSource: string | null = couple.commitSource ?? null;
  if (seq >= courtshipMinTurns(c.env)) {
    const closure = await assessClosure(c.env, coupleId, `court:${v.ownerId}`).catch(() => "continue" as const);
    state = resolveCoupleState(c.env, seq, closure);
    if (state === "committed") commitSource = "court";
  }

  await db
    .update(couples)
    .set({
      turnCount: seq,
      lastAppend: new Date().toISOString(),
      state,
      commitSource: state === "committed" ? commitSource : couple.commitSource,
    })
    .where(eq(couples.id, coupleId))
    .run();

  const targetId = authorId === mem.couple.aId ? mem.couple.bId : mem.couple.aId;
  if (inferred && seq >= courtshipMinTurns(c.env)) {
    const targetRow = await db.select({ heart: personas.heartJson }).from(personas).where(eq(personas.id, targetId)).get();
    const truth = (await open(c.env, targetRow?.heart ?? null)) ?? "";
    const result = scoreToM(inferred as InferredPrefs, truth);
    await recordToMProbe(db, { coupleId, proberPersonaId: authorId, targetPersonaId: targetId, result }).catch(() => {});
  }

  return c.json({ ok: true, coupleId, seq, authorId, state, commitSource: state === "committed" ? commitSource : null });
});
