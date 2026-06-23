/**
 * Coach memory — Phase 0 "capture before you coach". Human-side episodic substrate for Ishtar
 * Talk, keyed by the chat wallet `subject` (lowercased address). HUMANS ONLY.
 *
 * recordEpisode() is the generic capture used by the coach + matcher. recordFeedback() is the
 * feedback→discount loop: a rating or (high-signal) date debrief mints an episode AND awards
 * chat credits — the discount literally buys the proprietary "what actually landed" data the moat
 * depends on. Awards are CAPPED per UTC day so feedback isn't a free-credit faucet.
 */
import { and, eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { coachFeedback, episodes } from "../db/schema";
import { utcDay } from "../env";
import { addCredits } from "../economics/chatcredits";

export type EpisodeKind = "advice" | "debrief" | "feedback" | "match" | "note";

const lc = (a: string) => a.trim().toLowerCase();

/** Append one typed, importance-scored episode for a human (the compounding moat data). */
export async function recordEpisode(
  db: DB,
  e: { subject: string; kind: EpisodeKind; content: string; importance?: number; source?: string },
): Promise<void> {
  const content = (e.content ?? "").slice(0, 8000);
  if (!content) return;
  await db
    .insert(episodes)
    .values({
      subject: lc(e.subject),
      kind: e.kind,
      content,
      importance: Math.max(0, Math.min(1, e.importance ?? 0.5)),
      source: e.source ?? "coach",
    })
    .run();
}

// Credits per feedback kind — a real outcome debrief is worth far more than a thumbs-up.
const AWARD: Record<"rating" | "debrief", number> = { rating: 2, debrief: 10 };
// Hard ceiling on credits earnable from feedback per UTC day (anti-farming).
const DAILY_AWARD_CAP = 12;

export interface FeedbackInput {
  subject: string;
  kind: "rating" | "debrief";
  rating?: number; // 1..5 for kind=rating
  body?: string; // free text (required + substantive for kind=debrief)
}

/**
 * Store feedback, mint the corresponding episode, and award capped chat credits (the "discount").
 * Idempotency/anti-abuse: at most one credited award per KIND per day, and total feedback credits
 * never exceed DAILY_AWARD_CAP/day. Feedback is always stored (data is the point); credits may be 0.
 */
export async function recordFeedback(db: DB, e: FeedbackInput): Promise<{ awarded: number }> {
  const subject = lc(e.subject);
  const day = utcDay();

  const todays = await db
    .select()
    .from(coachFeedback)
    .where(and(eq(coachFeedback.subject, subject), eq(coachFeedback.day, day)))
    .all();
  const awardedToday = todays.reduce((s, r) => s + (r.creditsAwarded ?? 0), 0);
  const alreadyCreditedThisKind = todays.some((r) => r.kind === e.kind && (r.creditsAwarded ?? 0) > 0);

  const want = alreadyCreditedThisKind ? 0 : AWARD[e.kind];
  const awarded = Math.max(0, Math.min(want, DAILY_AWARD_CAP - awardedToday));

  await db
    .insert(coachFeedback)
    .values({
      subject,
      kind: e.kind,
      rating: e.kind === "rating" ? (e.rating ?? null) : null,
      body: e.body?.slice(0, 4000) ?? null,
      creditsAwarded: awarded,
      day,
    })
    .run();

  // Mint the episode — a debrief is the high-signal "what actually landed" record.
  await recordEpisode(db, {
    subject,
    kind: e.kind === "debrief" ? "debrief" : "feedback",
    content: e.kind === "rating" ? `rating:${e.rating}${e.body ? ` — ${e.body}` : ""}` : (e.body ?? ""),
    importance: e.kind === "debrief" ? 0.9 : 0.5,
    source: "feedback",
  });

  if (awarded > 0) await addCredits(db, subject, awarded);
  return { awarded };
}
