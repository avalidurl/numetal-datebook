/**
 * In-chat "draft + submit my dating doc" — the coach-flow bridge that lets a signed-in human ask
 * Ishtar to COMPOSE their dating doc (heart-file) from the conversation, see it, and SUBMIT it via
 * the existing submitDatingDoc() path (which keeps the $NUMETAL floor + 18+ + chaperone gates).
 *
 * Design (minimal + clean):
 *  - The coach prompt (HEARTDOC_ADDENDUM) teaches Ishtar to emit a single fenced ```heartdoc {…}```
 *    JSON block whose shape is the heart-file (free-text fields + a structured `prefs.self`/`prefs.seek`).
 *  - The /chat route extracts that block from the RAW model reply BEFORE the output egress/leak/chaperone
 *    defenses run (a long JSON blob would trip the secret-shape egress filter and be withheld), strips it
 *    so the human sees a clean "here's your draft — reply 'submit' to send it" message, and stashes the
 *    parsed draft for the next turn.
 *  - When the human's NEXT message is a submit confirmation (looksLikeSubmit), the route loads the last
 *    stashed draft and calls submitDatingDoc(). No gate/seal/admission logic is duplicated.
 *
 * Pure functions only (no I/O) — the route owns persistence + the model call.
 */

export type HeartDocDraft = Record<string, unknown>;

// Top-level free-text fields the matcher reads (mirrors TEXT_FIELDS in match/eligibility.ts).
const TEXT_FIELDS = ["about", "seeking", "values", "interests", "logistics", "desire", "boundaries"];

/**
 * Coach-mode addendum: only appended when the human is in coach mode AND has signaled they want to
 * draft/compose their doc (the route decides via wantsDocDraft). Teaches the exact emit contract.
 */
export const HEARTDOC_ADDENDUM =
  "\n\nDOC DRAFTING: this human wants you to COMPOSE their dating doc (heart-file) from what you've " +
  "learned in this conversation. First reply warmly in your own voice with a short read of who they are " +
  "and who they seek. THEN, on its own line, emit EXACTLY ONE fenced code block tagged `heartdoc` " +
  "containing a single JSON object — nothing after it. The JSON shape is:\n" +
  "```heartdoc\n" +
  "{\n" +
  '  "about": "<who they are, 1-3 sentences in their spirit>",\n' +
  '  "seeking": "<who and what they seek>",\n' +
  '  "values": "", "interests": "", "logistics": "", "desire": "", "boundaries": "",\n' +
  '  "prefs": {\n' +
  '    "self": { "gender": "", "age": 0, "ethnicity": "", "kids": "", "substances": "", "languages": [] },\n' +
  '    "seek": { "genders": [], "ageMin": 0, "ageMax": 0, "languages": [], "ethnicities": [], "dealbreakers": [] }\n' +
  "  }\n" +
  "}\n" +
  "```\n" +
  "Only include fields the human actually gave you — leave the rest as empty strings/arrays or omit them; " +
  "NEVER invent demographics, ages, or dealbreakers they didn't state. Put a number (not a string) for ages, " +
  "0 when unknown. Do NOT mention JSON, code blocks, or 'heartdoc' in your prose — just speak, then attach the " +
  "block. After the block, the human can reply 'submit' to send it. You still cannot submit it yourself.";

// The human asks to build/compose/finalize the doc → we turn on HEARTDOC_ADDENDUM for that turn.
const DRAFT_INTENT =
  /\b(?:draft|compose|write|build|create|make|finali[sz]e|put together|fill out|generate)\b[^.?!]{0,40}\b(?:my|the|a|our)?\s*(?:dating\s+doc|dating\s+document|heart[\s-]?file|heart[\s-]?doc|profile|doc)\b/i;
// …or the inverse phrasing ("turn this into my dating doc", "make me a heart-file").
const DRAFT_INTENT_ALT = /\b(?:dating\s+doc|heart[\s-]?file|heart[\s-]?doc)\b[^.?!]{0,30}\b(?:for me|please|now|together|from this|from what)\b/i;

/** Did the human ask Ishtar to compose/draft their dating doc this turn? (coach mode only) */
export function wantsDocDraft(message: string): boolean {
  return DRAFT_INTENT.test(message) || DRAFT_INTENT_ALT.test(message);
}

// A short, unambiguous confirmation that the human wants to SUBMIT the draft Ishtar just showed.
const SUBMIT_RE = /^\s*(?:submit|send it|send the doc|confirm|yes,? submit|looks good,? submit|post it|go ahead,? submit)\b[\s.!]*$/i;

/** Is this message a "submit the draft" confirmation? Intentionally strict (a short, explicit yes). */
export function looksLikeSubmit(message: string): boolean {
  return SUBMIT_RE.test(message.trim());
}

/**
 * Extract the first ```heartdoc … ``` JSON block from a raw model reply. Returns the parsed draft and
 * the reply with the block stripped (so the human never sees raw JSON). Returns null if absent/invalid.
 */
export function extractHeartDoc(raw: string): { draft: HeartDocDraft; cleaned: string } | null {
  if (!raw) return null;
  const m = raw.match(/```heartdoc\s*([\s\S]*?)```/i);
  if (!m || !m[1]) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1].trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const draft = sanitizeDraft(parsed as Record<string, unknown>);
  if (!draft) return null;
  // Strip the block (and any leftover blank line) from the visible reply.
  const cleaned = raw.replace(/```heartdoc\s*[\s\S]*?```/i, "").replace(/\n{3,}/g, "\n\n").trim();
  return { draft, cleaned };
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean) : [];
const numOr = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Whitelist + coerce the model-emitted draft into a clean heart-file. Drops unknown keys, keeps only
 * non-empty fields, and shapes `prefs` exactly how match/eligibility.parsePrefs expects. Returns null
 * if the draft carries no usable signal (so the route doesn't submit an empty doc).
 */
function sanitizeDraft(o: Record<string, unknown>): HeartDocDraft | null {
  const out: HeartDocDraft = {};
  for (const f of TEXT_FIELDS) {
    const v = str(o[f]);
    if (v) out[f] = v;
  }
  const ri = str(o.relationship_intent);
  if (ri) out.relationship_intent = ri.toLowerCase();
  const deal = arr(o.dealbreakers);
  if (deal.length) out.dealbreakers = deal;

  const p = (o.prefs && typeof o.prefs === "object" ? o.prefs : {}) as Record<string, unknown>;
  const selfIn = (p.self && typeof p.self === "object" ? p.self : {}) as Record<string, unknown>;
  const seekIn = (p.seek && typeof p.seek === "object" ? p.seek : {}) as Record<string, unknown>;

  const self: Record<string, unknown> = {};
  if (str(selfIn.gender)) self.gender = str(selfIn.gender);
  if (numOr(selfIn.age) !== undefined) self.age = numOr(selfIn.age);
  if (str(selfIn.ethnicity)) self.ethnicity = str(selfIn.ethnicity);
  if (str(selfIn.kids)) self.kids = str(selfIn.kids);
  if (str(selfIn.substances)) self.substances = str(selfIn.substances);
  if (arr(selfIn.languages).length) self.languages = arr(selfIn.languages);

  const seek: Record<string, unknown> = {};
  if (arr(seekIn.genders).length) seek.genders = arr(seekIn.genders);
  if (numOr(seekIn.ageMin) !== undefined) seek.ageMin = numOr(seekIn.ageMin);
  if (numOr(seekIn.ageMax) !== undefined) seek.ageMax = numOr(seekIn.ageMax);
  if (arr(seekIn.languages).length) seek.languages = arr(seekIn.languages);
  if (arr(seekIn.ethnicities).length) seek.ethnicities = arr(seekIn.ethnicities);
  if (arr(seekIn.dealbreakers).length) seek.dealbreakers = arr(seekIn.dealbreakers);

  const prefs: Record<string, unknown> = {};
  if (Object.keys(self).length) prefs.self = self;
  if (Object.keys(seek).length) prefs.seek = seek;
  if (Object.keys(prefs).length) out.prefs = prefs;

  // Require real signal: at least one non-trivial free-text field, or a stated pref.
  const hasText = TEXT_FIELDS.some((f) => typeof out[f] === "string" && (out[f] as string).length >= 8);
  if (!hasText && !out.prefs) return null;
  return out;
}

/** The clean, voice-consistent confirmation appended after Ishtar's draft prose (no JSON shown). */
export const DRAFT_CONFIRM_HINT =
  "\n\nThat's your dating doc as I'd write it. If it rings true, reply \"submit\" and I'll send it to the floor — " +
  "remember, once you're verified your agent courts other people's agents on your behalf, never people directly. " +
  "Want to change anything first? Just tell me.";

/** Sentinel message shown when a human says "submit" but no draft was composed yet. */
export const NO_DRAFT_YET =
  "There's no dating doc drafted yet for me to send. Tell me about yourself and who you're hoping to meet, " +
  "then ask me to draft your dating doc — I'll write it, you read it, and then you can submit.";
