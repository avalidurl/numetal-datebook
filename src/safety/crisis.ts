/**
 * Deterministic self-harm / suicidal-ideation crisis layer — the FIRM precaution.
 *
 * WHY THIS EXISTS (HeartBench finding, 2026-06-25): the coach model, told to "be the friend who
 * tells the truth, give concrete things to try," coached *through* a suicidal-ideation message
 * ("maybe everyone's better off without me") with dating advice — safety 0.0. A prompt clause helps
 * but is probabilistic; the generic Llama-Guard classifier either misses oblique phrasing or COLD-
 * BLOCKS it (422), neither of which is care. This layer is deterministic and runs BEFORE the charge,
 * the model, and the classifier, so a person in crisis is never coached-through nor coldly blocked —
 * they get a warm, vetted response with real resources. Vendor-agnostic; independent of Llama-Guard.
 *
 * Recall-biased on purpose: a false positive shows a support message (low harm); a false negative
 * misses a crisis (catastrophic). High-signal phrases fire alone; weaker despair phrases require
 * co-occurrence so ordinary dating frustration ("ugh, I can't do this anymore") doesn't cry wolf.
 */
import type { DB } from "../db/client";
import { events } from "../db/schema";

// Strong markers — a single hit is a crisis.
const STRONG: RegExp[] = [
  /\bkill(?:ing)?\s+myself\b/,
  // "want to die" but not "die my hair" / "die laughing" / "die of …" (benign hyperbole).
  /\b(?:want|wanna)\s+to\s+die\b(?!\s+(?:my|laughing|of|for|over))/,
  /\bend(?:ing)?\s+(?:my\s+life|it\s+all)\b/,
  /\bbetter\s+off\s+(?:without\s+me|dead|if\s+i\b)/,
  /\beveryone'?s?\s+better\s+off\b/,
  /\bno\s+(?:reason|point)\s+(?:to|in)\s+(?:live|living)\b/,
  /\bnot\s+worth\s+living\b/,
  /\bdon'?t\s+want\s+to\s+(?:be\s+here|live|exist)\b/,
  /\bsuicid/,
  /\b(?:harm|hurt|cut)(?:t?ing)?\s+myself\b/, // harm/harming, hurt/hurting, cut/cutting myself
  /\bself[-\s]?harm\b/,
  /\bcan'?t\s+go\s+on\b/,
];
// Weak markers — need at least two together (ambiguous in isolation).
const WEAK: RegExp[] = [
  /\bcan'?t\s+do\s+this\s+anymore\b/,
  /\bwhat'?s\s+the\s+point\b/,
  /\bgive\s+up\b/,
  /\bso\s+tired\b/,
  /\bnothing\s+matters\b/,
  /\bhopeless\b/,
  /\bcan'?t\s+take\s+(?:it|this)\b/,
];

export interface CrisisDetection {
  hit: boolean;
  severity: "strong" | "weak" | "none";
  matched: string[];
}

/** Pure, deterministic. Operates on the human's own words; lowercased + whitespace-collapsed. */
export function detectCrisis(text: string): CrisisDetection {
  const t = (text || "").toLowerCase().replace(/\s+/g, " ");
  const strong = STRONG.filter((re) => re.test(t)).map((re) => re.source);
  if (strong.length) return { hit: true, severity: "strong", matched: strong };
  const weak = WEAK.filter((re) => re.test(t)).map((re) => re.source);
  if (weak.length >= 2) return { hit: true, severity: "weak", matched: weak };
  return { hit: false, severity: "none", matched: [] };
}

/**
 * The vetted crisis response. Warm, brief, non-clinical, non-preachy; gives a real, region-aware
 * resource set. Edit with care — this is human-reviewed copy, not model output.
 */
export const CRISIS_RESPONSE =
  "I want to pause the dating talk, because what you just said matters far more than any of it. I'm " +
  "really glad you told me — and please hear this clearly: you are not a burden, and you deserve " +
  "support right now. Reach out to someone who can be with you in this — a person you trust, or a " +
  "crisis line. In the US you can call or text 988 (the Suicide & Crisis Lifeline), any time, free and " +
  "confidential. Anywhere in the world, findahelpline.com lists free, confidential lines near you, and " +
  "if you're in immediate danger please call your local emergency number. You don't have to carry this alone.";

/**
 * Flag a crisis intervention for the operator. PRIVACY: logs only the detection signal + caller —
 * never the verbatim message. Best-effort (never blocks the care response).
 */
export async function recordCrisisEvent(db: DB, callerRef: string, d: CrisisDetection): Promise<void> {
  await db
    .insert(events)
    .values({
      kind: "crisis_intervention",
      payload: JSON.stringify({ callerRef, severity: d.severity, matched: d.matched }),
    })
    .run()
    .catch(() => {});
}
