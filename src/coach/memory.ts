/**
 * Coach memory — Phase 0 "capture before you coach". Human-side episodic substrate for Ishtar
 * Talk, keyed by the chat wallet `subject` (lowercased address). HUMANS ONLY.
 *
 * recordEpisode() is the generic capture used by the coach + matcher. recordFeedback() is the
 * feedback→discount loop: a rating or (high-signal) date debrief mints an episode AND awards
 * chat credits — the discount literally buys the proprietary "what actually landed" data the moat
 * depends on. Awards are CAPPED per UTC day so feedback isn't a free-credit faucet.
 */
import type { DB } from "../db/client";
import { coachFeedback, episodes } from "../db/schema";
import { utcDay, type Env } from "../env";
import { seal } from "../crypto/box";
import { addCredits } from "../economics/chatcredits";

export type EpisodeKind = "advice" | "debrief" | "feedback" | "match" | "note";

const lc = (a: string) => a.trim().toLowerCase();

/** Append one typed, importance-scored episode for a human (the compounding moat data). */
export async function recordEpisode(
  db: DB,
  env: Env,
  e: { subject: string; kind: EpisodeKind; content: string; importance?: number; source?: string },
): Promise<void> {
  const content = (e.content ?? "").slice(0, 8000);
  if (!content) return;
  // Sealed at rest (AES-GCM, dark until ENCRYPTION_KEY set). Episodes are the durable, NON-TTL'd record,
  // so any PII a human fat-fingers into chat persists here the longest — encrypt it. Decrypted only in
  // reflectForSubject() to synthesize the lovemap. Legacy plaintext rows read back unchanged via open().
  const sealed = (await seal(env, content)) ?? content;
  await db
    .insert(episodes)
    .values({
      subject: lc(e.subject),
      kind: e.kind,
      content: sealed,
      importance: Math.max(0, Math.min(1, e.importance ?? 0.5)),
      source: e.source ?? "coach",
    })
    .run();
}

// Credits per feedback kind — a real outcome debrief is worth far more than a thumbs-up. With the
// per-(subject,kind,day) credit-once guarantee (migration 0014), these also cap the daily total at 12.
const AWARD: Record<"rating" | "debrief", number> = { rating: 2, debrief: 10 };

export interface FeedbackInput {
  subject: string;
  kind: "rating" | "debrief";
  rating?: number; // 1..5 for kind=rating
  body?: string; // free text (required + substantive for kind=debrief)
}

/**
 * Store feedback, mint the corresponding episode, and award chat credits (the "discount") — at most
 * ONCE per (subject, kind, day). The award is ATOMIC: insert a CREDITED row and let the partial unique
 * index (migration 0014) reject a racing second credited row for the same key, awarding only when the
 * insert actually created the row — the same idempotent pattern as chat top-ups. This closes the
 * TOCTOU race the old read-then-write had. Feedback is always stored (data is the point); credits 0.
 */
export async function recordFeedback(db: DB, env: Env, e: FeedbackInput): Promise<{ awarded: number }> {
  const subject = lc(e.subject);
  const day = utcDay();
  const award = AWARD[e.kind];
  // The debrief free-text is user PII ("met them at <address>…") and is NON-TTL'd — seal it at rest.
  // coach_feedback.body is write-only (read nowhere; dropped only on GDPR erasure), so no decrypt site.
  const row = {
    subject,
    kind: e.kind,
    rating: e.kind === "rating" ? (e.rating ?? null) : null,
    body: e.body ? await seal(env, e.body.slice(0, 4000)) : null,
  };

  // Atomically CLAIM the once-per-(subject,kind,day) credit: a racing second credited insert hits the
  // partial unique index and no-ops. Award only when this insert actually created the row.
  const claimed = await db
    .insert(coachFeedback)
    .values({ ...row, creditsAwarded: award, day })
    .onConflictDoNothing()
    .returning({ id: coachFeedback.id })
    .get();

  let awarded = 0;
  if (claimed) {
    awarded = award;
    await addCredits(db, subject, awarded);
  } else {
    // Already credited this kind today → still store the feedback (uncredited) for the data.
    await db.insert(coachFeedback).values({ ...row, creditsAwarded: 0, day }).run();
  }

  // Mint the episode — a debrief is the high-signal "what actually landed" record.
  await recordEpisode(db, env, {
    subject,
    kind: e.kind === "debrief" ? "debrief" : "feedback",
    content: e.kind === "rating" ? `rating:${e.rating}${e.body ? ` — ${e.body}` : ""}` : (e.body ?? ""),
    importance: e.kind === "debrief" ? 0.9 : 0.5,
    source: "feedback",
  });

  return { awarded };
}
