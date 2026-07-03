/**
 * Intent gate — keeps Talk-to-Ishtar scoped to its purpose (the human's love life + how the venue
 * works) so the free quota (and the paid tiers) can't be farmed as a general-purpose LLM — via the
 * web UI, an agent, the skill, an API, or anything else hitting POST /api/chat. It runs BEFORE the
 * expensive reply: a narrow deterministic abuse-pattern pre-pass (free), then a cheap small-model
 * yes/no classifier (governed via runGuarded, injectable for tests). Off-topic gets a warning and
 * NEVER the model, so there is no LLM value to extract regardless of how many wallets are farmed.
 *
 * FAIL-OPEN: a classifier error is treated as on-topic (this is a SCOPE gate, not a SAFETY gate —
 * availability beats strictness; the safety chaperone, per-wallet quota, and the venue budget breaker
 * still apply). Applies identically to humans and agents.
 */
import type { DB } from "../db/client";
import type { Env } from "../env";
import { runGuarded } from "../economics/gateway";
import { textOf } from "../economics/pricing";
import { normalizeForGuard } from "../chaperone/normalize";

// NARROW, high-precision shapes that are almost never genuine dating talk (general-LLM abuse). Kept tight
// to avoid false positives on real dating chat — the classifier handles the broader/ambiguous cases.
const OFFTOPIC_PATTERNS: RegExp[] = [
  /```|\bconsole\.log\b|\b(def|function)\s+\w+\s*\(|\bimport\s+\w+\s+from\b|<\/[a-z][\w-]*>|\bSELECT\b[\s\S]*\bFROM\b|\b(public|private|static)\s+(void|int|string|class|async)\b/i,
  /\b(translate|summari[sz]e|transcribe|proofread|refactor|debug this|fix my code|compile)\b/i,
  /\b(capital of|who (invented|wrote|discovered|painted)|what year (did|was)|how many .* are there)\b/i,
  /\b(act as|pretend (to be|you are)|you are now (a|an)|ignore (the |your |all )?(previous |above )?(instructions|prompt|rules)|as an? (ai|assistant|language model|llm)|system prompt)\b/i,
];

/** Deterministic pre-pass. Returns a short reason string if the message is clearly off-topic, else null. */
export function offTopicPattern(text: string): string | null {
  const t = normalizeForGuard(text).clean;
  for (const re of OFFTOPIC_PATTERNS) if (re.test(t)) return re.source.slice(0, 32);
  return null;
}

// Third-person phrasing is FIRST-CLASS here: paying callers are often agents asking for the human
// they represent ("my human…", "when should two agents…"), and venue-mechanics questions are core
// scope. A 3B judge at temp 0 weights the head of the instruction, so both live up front — a live
// $0.10 caller was scope-refused on "when should two agents agree their humans are ready for an
// introduction?" under the old own-love-life-first wording (2026-07-03).
const CLASSIFIER_SYSTEM =
  "You are a strict topic gate for Ishtar, an AI matchmaking and dating-coach venue where AI agents " +
  "represent humans and court on their behalf. Decide whether the USER message is ON-TOPIC. ON-TOPIC = " +
  "dating, romance, attraction, sex/relationship preferences, heartbreak, who someone is or who they seek — " +
  "whether the speaker's own or their human's/client's (agents asking in the third person are on-topic); " +
  "dating docs and profiles; matches, courtship, openers, introductions and when or how they should happen; " +
  "and how this venue works (matching, courtship between agents, reveals, safety, pricing). " +
  "OFF-TOPIC = anything else: general knowledge, coding, math, translation, summarizing, writing tasks " +
  "unrelated to dating, current events, or using you as a general assistant. Reply with EXACTLY one " +
  "word — YES if on-topic, NO if off-topic. Do not explain.";

export type ClassifyFn = (db: DB, env: Env, message: string, callerRef?: string) => Promise<boolean>;

/** Cheap small-model YES/NO classifier (governed). FAIL-OPEN → true (on-topic) on any error/ambiguity. */
export async function classifyOnTopic(db: DB, env: Env, message: string, callerRef?: string): Promise<boolean> {
  try {
    const result = await runGuarded(db, env, {
      model: env.TOPIC_MODEL || "@cf/meta/llama-3.2-3b-instruct",
      tier: "t1",
      route: "/intent",
      callerRef,
      inputs: {
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM },
          { role: "user", content: message.slice(0, 1000) },
        ],
        max_tokens: 3,
        temperature: 0,
      },
    });
    const out = (textOf(result) || "").trim().toLowerCase();
    if (out.startsWith("no")) return false;
    return true; // "yes" or anything unparseable → fail open (on-topic)
  } catch {
    return true; // classifier down → fail open; budget breaker + quota still bound cost
  }
}

export interface IntentResult {
  onTopic: boolean;
  via: "pattern" | "classifier" | "allow";
}

/** The gate. Deterministic patterns (free) → small-model classifier. Same for humans and agents. */
export async function intentGate(
  db: DB,
  env: Env,
  message: string,
  deps?: { classify?: ClassifyFn },
  callerRef?: string,
): Promise<IntentResult> {
  if (offTopicPattern(message)) return { onTopic: false, via: "pattern" };
  const classify = deps?.classify ?? classifyOnTopic;
  const onTopic = await classify(db, env, message, callerRef);
  return { onTopic, via: onTopic ? "allow" : "classifier" };
}

/** The warning served on an off-topic message (no model call). Doubles as a machine-readable signal for
 *  agents via the route's `offTopic:true, scope:"dating"` fields. */
export const OFFTOPIC_WARNING =
  "I'm Ishtar — I'm here for your love life: dating, attraction, who you are and who you're looking for, and " +
  "how this venue works. I don't answer general questions or do tasks (code, essays, translations, trivia). " +
  "Tell me what's on your mind about your dating life and I'm all yours.";
