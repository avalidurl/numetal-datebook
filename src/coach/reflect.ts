/**
 * Reflection job (Phase 2) — the part that earns the "knows you" claim.
 *
 * A scheduled sweep synthesizes, per human, a short "lovemap" from their episode log (coaching
 * exchanges, date debriefs, feedback). EVERY claim must cite the episode ids it rests on — an
 * untraceable reflection is a hallucinated dependency that reads as a flattering horoscope (the
 * companion-app failure mode), so the model is forced to ground in real episodes or say the log is
 * too thin. coachContext() feeds the latest reflection back into coach-mode chat — that injected,
 * evidence-grounded self-knowledge is the line a stateless LLM cannot cross.
 *
 * Inference goes through the same governed path as the rest of the venue (runGuarded → AI Gateway
 * + cost ledger). The sweep is bounded per run and capped globally by the gateway dollar limit.
 */
import { desc, eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { episodes, reflections } from "../db/schema";
import type { Env } from "../env";
import { looksLikeSystemLeak } from "../chat/ishtar";
import { egressFilter } from "../xmtp/egress";
import { runGuarded } from "../economics/gateway";
import { textOf } from "../economics/pricing";

const MAX_EPISODES = 24;
const MIN_TO_REFLECT = 3;

export interface EpisodeRow {
  id: number;
  kind: string;
  content: string;
  importance: number;
  createdAt: string;
}

/** Scored selection: highest-importance first, then most-recent. (Embedding relevance: later.) */
export async function loadEpisodesForReflection(db: DB, subject: string, limit = MAX_EPISODES): Promise<EpisodeRow[]> {
  return (await db
    .select({ id: episodes.id, kind: episodes.kind, content: episodes.content, importance: episodes.importance, createdAt: episodes.createdAt })
    .from(episodes)
    .where(eq(episodes.subject, subject.toLowerCase()))
    .orderBy(desc(episodes.importance), desc(episodes.id))
    .limit(limit)
    .all()) as EpisodeRow[];
}

const REFLECT_SYSTEM =
  "You are Ishtar's private analyst. You are given ONE person's episode log from the dating venue — " +
  "coaching exchanges, date debriefs, and feedback, each tagged with an id like #12. Synthesize a SHORT " +
  "'lovemap': 2–4 recurring patterns in how this person dates — what consistently lands, where they " +
  "self-sabotage, their blind spots. RULES: every claim MUST cite the episode ids it rests on, e.g. " +
  "'(see #4, #11)'. No flattery, no horoscope, no generic advice — only what the episodes actually " +
  "support. If the log is too thin to support a pattern, say exactly that. Plain text, under 180 words.";

/** Generate + store one cited reflection for a subject. Returns ok:false (never throws) when skipped. */
export async function reflectForSubject(db: DB, env: Env, subject: string): Promise<{ ok: boolean; reflectionId?: number; reason?: string }> {
  const subj = subject.toLowerCase();
  const eps = await loadEpisodesForReflection(db, subj);
  if (eps.length < MIN_TO_REFLECT) return { ok: false, reason: "too few episodes" };

  const log = eps.map((e) => `#${e.id} [${e.kind}] ${e.content.slice(0, 600)}`).join("\n");
  let summary = "";
  try {
    const result = await runGuarded(db, env, {
      model: env.CHAT_MODEL || env.GAMBIT_MODEL,
      tier: "t1",
      route: "/coach/reflect",
      callerRef: `reflect:${subj}`,
      paid: false,
      inputs: { messages: [{ role: "system", content: REFLECT_SYSTEM }, { role: "user", content: log }], max_tokens: 400, temperature: 0.3 },
    });
    summary = (textOf(result) || "").trim();
  } catch {
    return { ok: false, reason: "inference error" };
  }
  if (!summary) return { ok: false, reason: "empty reflection" };
  // Defense-in-depth (audit hardening): never persist/inject a reflection that echoes system/
  // instruction text — it would otherwise resurface verbatim in a later coach session.
  if (looksLikeSystemLeak(summary) || !egressFilter(summary).safe)
    return { ok: false, reason: "reflection withheld: instruction/secret echo" };

  const row = await db
    .insert(reflections)
    .values({ subject: subj, summary: summary.slice(0, 4000), cites: JSON.stringify(eps.map((e) => e.id)) })
    .returning({ id: reflections.id })
    .get();
  return { ok: true, reflectionId: row?.id };
}

/**
 * Sweep: reflect for subjects whose newest episode is newer than their newest reflection (or who
 * have none), with at least MIN_TO_REFLECT episodes. Bounded per run for cost. Best-effort per subject.
 */
export async function runReflectionSweep(db: DB, env: Env, maxSubjects = 10): Promise<{ processed: number; due: number }> {
  const due =
    (
      await env.DB.prepare(
        `SELECT e.subject AS subject FROM episodes e
         LEFT JOIN (SELECT subject, MAX(created_at) last_ref FROM reflections GROUP BY subject) r ON r.subject = e.subject
         GROUP BY e.subject
         HAVING COUNT(*) >= ?1 AND MAX(e.created_at) > COALESCE(r.last_ref, '')
         LIMIT ?2`,
      )
        .bind(MIN_TO_REFLECT, maxSubjects)
        .all<{ subject: string }>()
    ).results ?? [];

  let processed = 0;
  for (const d of due) {
    try {
      if ((await reflectForSubject(db, env, d.subject)).ok) processed++;
    } catch {
      /* best-effort: one subject's failure never stalls the sweep */
    }
  }
  return { processed, due: due.length };
}

/**
 * Coach context for injection into coach-mode chat: the latest reflection (the person's lovemap).
 * Returns "" when there's nothing yet (cold start → generic coach, per the honest sequencing).
 */
export async function coachContext(db: DB, subject: string): Promise<string> {
  const ref = await db
    .select({ summary: reflections.summary })
    .from(reflections)
    .where(eq(reflections.subject, subject.toLowerCase()))
    .orderBy(desc(reflections.id))
    .limit(1)
    .get();
  if (!ref?.summary) return "";
  return (
    "\n\nWHAT YOU KNOW ABOUT THIS PERSON, from their own history on the venue (use it to be specific; " +
    "never quote episode ids, never say 'episode' or 'log' to them — just speak as someone who remembers):\n" +
    ref.summary
  );
}
