/**
 * Match eligibility — the hard preference gate the kNN shortlist alone doesn't enforce
 * (committee finding): semantic nearness is not the same as a viable match. Before any
 * pair becomes a couple we check three things parsed from the heart-files:
 *   - market: the two can actually meet (shared active market, or one is remote/online),
 *   - intent: relationship intents aren't flatly incompatible (casual vs long-term),
 *   - dealbreakers: neither lists a dealbreaker the other's heart plainly contains.
 * Pure functions, no I/O — cheap to call per candidate edge and unit-testable.
 */
export interface ParsedHeart {
  text: string; // lowercased blob of free-text fields, for dealbreaker scanning
  dealbreakers: string[]; // lowercased terms
  intent: string; // relationship_intent, lowercased ("" if unstated)
}

export interface EligPersona {
  id: number;
  activeMarket: string;
  homeMarket: string;
  parsed: ParsedHeart;
}

const TEXT_FIELDS = ["about", "seeking", "values", "interests", "logistics", "desire", "boundaries"];

export function parseHeart(raw: string): ParsedHeart {
  let obj: Record<string, unknown> | null = null;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object") obj = j as Record<string, unknown>;
  } catch {
    /* plain text heart */
  }
  if (!obj) return { text: raw.toLowerCase(), dealbreakers: [], intent: "" };

  const parts: string[] = [];
  for (const k of TEXT_FIELDS) {
    const v = obj[k];
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) parts.push(v.filter((x): x is string => typeof x === "string").join(" "));
  }
  const dealbreakers = Array.isArray(obj.dealbreakers)
    ? (obj.dealbreakers as unknown[])
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.toLowerCase().trim())
        .filter(Boolean)
    : [];
  const intent = typeof obj.relationship_intent === "string" ? obj.relationship_intent.toLowerCase().trim() : "";
  return { text: parts.join(" \n ").toLowerCase(), dealbreakers, intent };
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

export function compatible(a: EligPersona, b: EligPersona): { ok: boolean; reason?: string } {
  if (!marketsCompatible(a, b)) return { ok: false, reason: "market" };
  if (!intentsCompatible(a.parsed, b.parsed)) return { ok: false, reason: "intent" };
  if (!dealbreakerFree(a.parsed, b.parsed)) return { ok: false, reason: "dealbreaker" };
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
