/**
 * Deterministic minor / underage short-circuit — a firm safety layer alongside crisis.ts.
 *
 * WHY (HeartBench safety gate, 2026-06-25): run ×5, the coach model handled a self-disclosed
 * 16-year-old correctly only 4/5 times — once it began to refuse, then coached anyway (safety 0.0).
 * The venue is adults-only; we must not depend on the model. This detects a self-disclosed minor age
 * and short-circuits to a kind, non-coaching "adults only" redirect BEFORE the model runs.
 *
 * Scope: this catches *disclosed* age only. Undisclosed age is out of scope for chat — the binding
 * age check is human-side identity verification (Didit) before any real-world meeting is ever arranged.
 */
import type { DB } from "../db/client";
import { events } from "../db/schema";

const MINOR: RegExp[] = [
  // "I'm 16 years old" / "I'm 16 yo"
  /\bi(?:'?m| am)\s+(?:only\s+)?1[0-7]\s*(?:years?\s*old|yrs?\s*old|y\/?o)\b/,
  // "I'm 16" only when clearly an age statement (end, punctuation, or a dating-context follower) —
  // NOT "I'm 16 minutes away" / "I'm 12 years into my career".
  /\bi(?:'?m| am)\s+(?:only\s+)?1[0-7]\b(?=[.,!?)]|\s+(?:and|but|so|i|though|now|this|next|years?\s+old)|$)/,
  /\bi(?:'?m| am)\s+(?:a\s+)?(?:minor|underage|under\s*-?\s*18|not\s+(?:yet\s+)?(?:18|an?\s+adult))\b/,
  /\bi(?:'?m| am)\s+(?:still\s+)?in\s+(?:high\s*school|middle\s*school|[6-9]th\s+grade|1[01]th\s+grade)\b/,
];

/** Pure, deterministic. True when the message self-discloses an under-18 age. */
export function detectMinor(text: string): boolean {
  const t = (text || "").toLowerCase().replace(/\s+/g, " ");
  return MINOR.some((re) => re.test(t));
}

/** Kind, non-coaching, non-preachy redirect. Human-reviewed copy. */
export const MINOR_REDIRECT =
  "I have to be straight with you: Ishtar is an adults-only (18+) venue, so I can't be your dating " +
  "coach here — and I won't pretend otherwise. That's no knock on you; what you're feeling is real " +
  "and it matters. The best things I can tell you cost nothing: be kind, be honest, and talk it over " +
  "with friends or an adult you trust. Take good care of yourself.";

/** Operator flag (no verbatim message). Best-effort. */
export async function recordMinorEvent(db: DB, callerRef: string): Promise<void> {
  await db
    .insert(events)
    .values({ kind: "minor_redirect", payload: JSON.stringify({ callerRef }) })
    .run()
    .catch(() => {});
}
