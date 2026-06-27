/**
 * Match eligibility — the hard preference gate the kNN shortlist alone doesn't enforce
 * (committee finding): semantic nearness is not the same as a viable match. Before any
 * pair becomes a couple we check, parsed from the heart-files:
 *   - market: the two can actually meet (shared active market, or one is remote/online),
 *   - intent: relationship intents aren't flatly incompatible (casual vs long-term),
 *   - free-text dealbreakers: neither lists a term the other's heart plainly contains,
 *   - structured preferences (`prefs`): gender/orientation, age range, languages, kids,
 *     substances, and ethnicity — entered as MUTUAL hard filters when stated.
 * Pure functions, no I/O — cheap to call per candidate edge and unit-testable.
 */
export interface HeartPrefs {
  // self-described (lowercased)
  gender?: string;
  age?: number;
  ethnicity?: string;
  kids?: string; // "have" | "want" | "no" | "open" | ""
  substances?: string; // self, e.g. "none" | "social" | "smoker"
  languages: string[];
  // what this person will accept in a partner — a stated filter is a HARD dealbreaker
  seekGenders: string[];
  ageMin?: number;
  ageMax?: number;
  seekLanguages: string[]; // require ≥1 shared
  seekEthnicities: string[]; // if set, the partner's ethnicity must be in it (race/ethnicity dealbreaker)
  excludeSubstances: string[]; // the partner must NOT be one of these
}

export interface ParsedHeart {
  text: string; // lowercased blob of free-text fields, for dealbreaker scanning
  dealbreakers: string[]; // lowercased terms (free-text)
  intent: string; // relationship_intent, lowercased ("" if unstated)
  prefs?: HeartPrefs; // structured hard filters (all optional; missing → not enforced)
}

export interface EligPersona {
  id: number;
  activeMarket: string;
  homeMarket: string;
  parsed: ParsedHeart;
}

const TEXT_FIELDS = ["about", "seeking", "values", "interests", "logistics", "desire", "boundaries"];
const EMPTY_PREFS: HeartPrefs = { languages: [], seekGenders: [], seekLanguages: [], seekEthnicities: [], excludeSubstances: [] };

const lstr = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.toLowerCase().trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const larr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.toLowerCase().trim()).filter(Boolean) : [];

/** Read the optional structured `prefs` block ({ self:{…}, seek:{…} }) into a normalized HeartPrefs. */
function parsePrefs(p: unknown): HeartPrefs {
  if (!p || typeof p !== "object") return EMPTY_PREFS;
  const o = p as Record<string, unknown>;
  const self = (o.self && typeof o.self === "object" ? o.self : {}) as Record<string, unknown>;
  const seek = (o.seek && typeof o.seek === "object" ? o.seek : {}) as Record<string, unknown>;
  const seekDeal = (seek.dealbreakers && typeof seek.dealbreakers === "object" ? seek.dealbreakers : {}) as Record<string, unknown>;
  return {
    gender: lstr(self.gender),
    age: num(self.age),
    ethnicity: lstr(self.ethnicity ?? self.race),
    kids: lstr(self.kids),
    substances: lstr(self.substances),
    languages: larr(self.languages),
    seekGenders: larr(seek.genders),
    ageMin: num(seek.ageMin),
    ageMax: num(seek.ageMax),
    seekLanguages: larr(seek.languages),
    seekEthnicities: larr(seek.ethnicities ?? seek.races), // the race/ethnicity dealbreaker
    excludeSubstances: larr(seekDeal.substances ?? seek.excludeSubstances),
  };
}

export function parseHeart(raw: string): ParsedHeart {
  let obj: Record<string, unknown> | null = null;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object") obj = j as Record<string, unknown>;
  } catch {
    /* plain text heart */
  }
  if (!obj) return { text: raw.toLowerCase(), dealbreakers: [], intent: "", prefs: EMPTY_PREFS };

  const parts: string[] = [];
  for (const k of TEXT_FIELDS) {
    const v = obj[k];
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) parts.push(v.filter((x): x is string => typeof x === "string").join(" "));
  }
  const dealbreakers = Array.isArray(obj.dealbreakers)
    ? (obj.dealbreakers as unknown[]).filter((x): x is string => typeof x === "string").map((s) => s.toLowerCase().trim()).filter(Boolean)
    : [];
  const intent = typeof obj.relationship_intent === "string" ? obj.relationship_intent.toLowerCase().trim() : "";
  return { text: parts.join(" \n ").toLowerCase(), dealbreakers, intent, prefs: parsePrefs(obj.prefs) };
}

// Flatly-incompatible relationship intents (anything not listed here is treated as compatible).
const INCOMPATIBLE_INTENTS = new Set(["casual|long-term", "long-term|casual", "casual|marriage", "marriage|casual"]);

const isRemote = (m: string): boolean => m === "remote" || m === "online";

function marketsCompatible(a: EligPersona, b: EligPersona): boolean {
  if (isRemote(a.activeMarket) || isRemote(b.activeMarket)) return true;
  return a.activeMarket === b.activeMarket;
}

function intentsCompatible(a: ParsedHeart, b: ParsedHeart): boolean {
  if (!a.intent || !b.intent) return true;
  return !INCOMPATIBLE_INTENTS.has(`${a.intent}|${b.intent}`);
}

function dealbreakerFree(a: ParsedHeart, b: ParsedHeart): boolean {
  for (const t of a.dealbreakers) if (t.length >= 3 && b.text.includes(t)) return false;
  for (const t of b.dealbreakers) if (t.length >= 3 && a.text.includes(t)) return false;
  return true;
}

// kids: incompatible only when one explicitly wants and the other explicitly refuses (symmetric).
function kidsCompatible(x?: string, y?: string): boolean {
  if (!x || !y) return true;
  const no = (k: string) => k === "no" || k === "none" || k === "never";
  const want = (k: string) => k === "want" || k === "wants" || k === "yes";
  return !((no(x) && want(y)) || (want(x) && no(y)));
}

/**
 * Structured-preference gate. Each stated filter is a MUTUAL hard dealbreaker: it bites only when
 * the filter is set AND the other side's matching attribute is known. Missing data never excludes
 * (back-compat with prose-only hearts; can't filter on what wasn't stated).
 */
export function prefsCompatible(a: HeartPrefs, b: HeartPrefs): { ok: boolean; reason?: string } {
  // gender / orientation
  if (a.seekGenders.length && b.gender !== undefined && !a.seekGenders.includes(b.gender)) return { ok: false, reason: "gender" };
  if (b.seekGenders.length && a.gender !== undefined && !b.seekGenders.includes(a.gender)) return { ok: false, reason: "gender" };
  // age range
  if (b.age !== undefined && ((a.ageMin !== undefined && b.age < a.ageMin) || (a.ageMax !== undefined && b.age > a.ageMax))) return { ok: false, reason: "age" };
  if (a.age !== undefined && ((b.ageMin !== undefined && a.age < b.ageMin) || (b.ageMax !== undefined && a.age > b.ageMax))) return { ok: false, reason: "age" };
  // ethnicity / race — entered as an accept-list; the partner must be in it
  if (a.seekEthnicities.length && b.ethnicity !== undefined && !a.seekEthnicities.includes(b.ethnicity)) return { ok: false, reason: "ethnicity" };
  if (b.seekEthnicities.length && a.ethnicity !== undefined && !b.seekEthnicities.includes(a.ethnicity)) return { ok: false, reason: "ethnicity" };
  // languages — require ≥1 shared when a side asks and the other lists any
  if (a.seekLanguages.length && b.languages.length && !a.seekLanguages.some((l) => b.languages.includes(l))) return { ok: false, reason: "language" };
  if (b.seekLanguages.length && a.languages.length && !b.seekLanguages.some((l) => a.languages.includes(l))) return { ok: false, reason: "language" };
  // substances — excluded behaviours
  if (a.excludeSubstances.length && b.substances !== undefined && a.excludeSubstances.includes(b.substances)) return { ok: false, reason: "substance" };
  if (b.excludeSubstances.length && a.substances !== undefined && b.excludeSubstances.includes(a.substances)) return { ok: false, reason: "substance" };
  // kids
  if (!kidsCompatible(a.kids, b.kids)) return { ok: false, reason: "kids" };
  return { ok: true };
}

export function compatible(a: EligPersona, b: EligPersona): { ok: boolean; reason?: string } {
  if (!marketsCompatible(a, b)) return { ok: false, reason: "market" };
  if (!intentsCompatible(a.parsed, b.parsed)) return { ok: false, reason: "intent" };
  if (!dealbreakerFree(a.parsed, b.parsed)) return { ok: false, reason: "dealbreaker" };
  const pc = prefsCompatible(a.parsed.prefs ?? EMPTY_PREFS, b.parsed.prefs ?? EMPTY_PREFS);
  if (!pc.ok) return pc;
  return { ok: true };
}

/**
 * Cold-start score when embeddings/Vectorize are unavailable: a small, explainable
 * heuristic (shared market + matching intent + light lexical overlap) so the very first
 * cohort is paired on real signal, NOT insertion order (committee finding).
 */
export function coldScore(a: EligPersona, b: EligPersona): number {
  let s = 0.4;
  if (a.activeMarket === b.activeMarket) s += 0.1;
  if (a.parsed.intent && a.parsed.intent === b.parsed.intent) s += 0.1;
  const at = new Set(a.parsed.text.split(/\W+/).filter((w) => w.length > 4));
  let overlap = 0;
  for (const w of b.parsed.text.split(/\W+/)) if (w.length > 4 && at.has(w)) overlap++;
  return Math.min(0.95, s + Math.min(0.3, overlap * 0.02));
}

/**
 * Safety flag (P7): a large age gap on couple formation gets logged for operator review — NOT a
 * hard block (consenting adults can have age gaps), but a grooming-risk tripwire. Flags a large
 * absolute gap, OR a moderate gap when one party is young. Ages come from the structured prefs
 * (self.age); missing ages never flag (we don't fabricate suspicion from absent data).
 */
export function ageGapFlag(ageA?: number, ageB?: number, thresholdYears = 18): { flagged: boolean; gap: number; reason: string } {
  if (!ageA || !ageB) return { flagged: false, gap: 0, reason: "" };
  const gap = Math.abs(ageA - ageB);
  const younger = Math.min(ageA, ageB);
  if (gap >= thresholdYears) return { flagged: true, gap, reason: `age gap ${gap}y (≥${thresholdYears})` };
  if (younger < 25 && gap >= 12) return { flagged: true, gap, reason: `age gap ${gap}y, young party (${younger})` };
  return { flagged: false, gap, reason: "" };
}
