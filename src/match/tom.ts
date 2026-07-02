/**
 * Theory-of-Mind probes (P5). A cross-model date is only interesting if the daters actually MODEL each
 * other — so we score how accurately one persona (the "prober") infers the OTHER's sealed heart-file
 * preferences. The ground truth is the partner's DECRYPTED heart (crypto/box `open` → parseHeart); the
 * prober's guess is a small structured `InferredPrefs`. The scorer is a pure function (no I/O, no LLM)
 * so it is deterministic and unit-testable; the persistence helper writes the earned score to the
 * `tom_probes` table that HeartBench v2 reads.
 *
 * Scoring is EARNED, never stamped: each stated ground-truth constraint the prober gets right is a hit,
 * each one it gets wrong is a miss, and each constraint the prober INVENTS that the target never stated
 * is a hallucination (penalized). A probe that compares no fields at all yields no score — a bare 0.5
 * placeholder is rejected as invalid so an un-inferred date can never be laundered into the leaderboard.
 */
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { tomProbes } from "../db/schema";
import { type HeartPrefs, parseHeart } from "./eligibility";

/**
 * What a prober claims about its partner. Every field is optional — the prober only asserts what it
 * believes it inferred; an omitted field is simply "no claim" (neither rewarded nor penalized). The
 * shape mirrors the scorable subset of HeartPrefs (self attributes + stated seek/dealbreaker filters).
 */
export interface InferredPrefs {
  gender?: string;
  age?: number;
  ethnicity?: string;
  kids?: string;
  substances?: string;
  languages?: string[];
  seekGenders?: string[];
  ageMin?: number;
  ageMax?: number;
  seekLanguages?: string[];
  seekEthnicities?: string[];
  excludeSubstances?: string[];
}

export interface ToMFieldResult {
  field: string;
  outcome: "hit" | "miss" | "hallucination";
  inferred: unknown;
  actual: unknown;
}

export interface ToMScore {
  score: number; // 0..1 earned accuracy
  hits: number;
  misses: number;
  hallucinations: number;
  compared: number; // total scored comparisons (hits + misses + hallucinations)
  fields: ToMFieldResult[];
}

const norm = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.toLowerCase().trim() : undefined;
const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.toLowerCase().trim()).filter(Boolean) : [];
const numOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Set equality on lowercased string sets (order-independent). */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

/** Score one scalar (string) field: hit if it matches truth, miss if wrong, hallucination if the
 *  prober asserts a value the target never stated. No claim + no truth → not scored (undefined). */
function scoreScalar(inferred: string | undefined, actual: string | undefined): ToMFieldResult["outcome"] | undefined {
  if (inferred === undefined) return undefined; // no claim
  if (actual === undefined) return "hallucination"; // invented a constraint the target never stated
  return inferred === actual ? "hit" : "miss";
}

/** Score one set field (e.g. seekGenders): hit if identical set, hallucination if prober invents a
 *  filter the target never stated, miss otherwise. */
function scoreSet(inferred: string[] | undefined, actual: string[]): ToMFieldResult["outcome"] | undefined {
  if (inferred === undefined) return undefined;
  if (actual.length === 0) return inferred.length === 0 ? undefined : "hallucination";
  return sameSet(inferred, actual) ? "hit" : "miss";
}

/** Score an inferred age band [min,max] against the target's stated band. A partial/looser guess is a
 *  miss; an invented band the target never stated is a hallucination. */
function scoreBand(iMin: number | undefined, iMax: number | undefined, aMin: number | undefined, aMax: number | undefined): ToMFieldResult["outcome"] | undefined {
  const claimed = iMin !== undefined || iMax !== undefined;
  const stated = aMin !== undefined || aMax !== undefined;
  if (!claimed) return undefined;
  if (!stated) return "hallucination";
  return iMin === aMin && iMax === aMax ? "hit" : "miss";
}

/**
 * Score a prober's inference of the partner's prefs against the DECRYPTED heart-file text.
 * `truthHeartText` is the plaintext heart JSON (already `open()`-ed by the caller). Pure + deterministic.
 */
export function scoreToM(inferred: InferredPrefs, truthHeartText: string): ToMScore {
  const truth: HeartPrefs = parseHeart(truthHeartText ?? "").prefs ?? {
    languages: [], seekGenders: [], seekLanguages: [], seekEthnicities: [], excludeSubstances: [],
  };
  const fields: ToMFieldResult[] = [];

  const push = (field: string, outcome: ToMFieldResult["outcome"] | undefined, inf: unknown, act: unknown) => {
    if (outcome) fields.push({ field, outcome, inferred: inf, actual: act });
  };

  push("gender", scoreScalar(norm(inferred.gender), truth.gender), inferred.gender, truth.gender);
  push("ethnicity", scoreScalar(norm(inferred.ethnicity), truth.ethnicity), inferred.ethnicity, truth.ethnicity);
  push("kids", scoreScalar(norm(inferred.kids), truth.kids), inferred.kids, truth.kids);
  push("substances", scoreScalar(norm(inferred.substances), truth.substances), inferred.substances, truth.substances);
  // self age: a scalar equality
  if (inferred.age !== undefined) {
    const out: ToMFieldResult["outcome"] = truth.age === undefined ? "hallucination" : numOf(inferred.age) === truth.age ? "hit" : "miss";
    push("age", out, inferred.age, truth.age);
  }
  push("languages", scoreSet(inferred.languages && arr(inferred.languages), truth.languages), inferred.languages, truth.languages);
  push("seekGenders", scoreSet(inferred.seekGenders && arr(inferred.seekGenders), truth.seekGenders), inferred.seekGenders, truth.seekGenders);
  push("seekLanguages", scoreSet(inferred.seekLanguages && arr(inferred.seekLanguages), truth.seekLanguages), inferred.seekLanguages, truth.seekLanguages);
  push("seekEthnicities", scoreSet(inferred.seekEthnicities && arr(inferred.seekEthnicities), truth.seekEthnicities), inferred.seekEthnicities, truth.seekEthnicities);
  push("excludeSubstances", scoreSet(inferred.excludeSubstances && arr(inferred.excludeSubstances), truth.excludeSubstances), inferred.excludeSubstances, truth.excludeSubstances);
  push("ageBand", scoreBand(numOf(inferred.ageMin), numOf(inferred.ageMax), truth.ageMin, truth.ageMax), { min: inferred.ageMin, max: inferred.ageMax }, { min: truth.ageMin, max: truth.ageMax });

  const hits = fields.filter((f) => f.outcome === "hit").length;
  const misses = fields.filter((f) => f.outcome === "miss").length;
  const hallucinations = fields.filter((f) => f.outcome === "hallucination").length;
  const compared = fields.length;
  // Earned accuracy: hits over everything the prober was scored on (misses AND hallucinations both drag
  // the score down). No comparisons at all → 0 (nothing was actually inferred).
  const score = compared === 0 ? 0 : hits / compared;
  return { score: Math.round(score * 1e6) / 1e6, hits, misses, hallucinations, compared, fields };
}

/**
 * A ToM score is VALID only if it was earned — i.e. the scorer actually compared at least one field.
 * This is the guard against a laundered placeholder: a bare 0.5 (or any number) attached to a probe
 * that inferred nothing (`compared === 0`) is rejected. HeartBench v2 must only ingest earned scores.
 */
export function isEarnedToM(result: ToMScore): boolean {
  if (result.compared <= 0) return false; // nothing inferred → not earned
  if (!Number.isFinite(result.score) || result.score < 0 || result.score > 1) return false;
  // The score must be the arithmetic the fields imply, not an injected constant.
  const expected = Math.round((result.hits / result.compared) * 1e6) / 1e6;
  return Math.abs(result.score - expected) < 1e-9;
}

/**
 * Persist an EARNED ToM probe to `tom_probes` (the HeartBench v2 contract). Throws on an unearned score
 * so a placeholder can never reach the leaderboard table. Returns the inserted row id.
 */
export async function recordToMProbe(
  db: DB,
  probe: { coupleId: number; proberPersonaId: number; targetPersonaId: number; result: ToMScore },
): Promise<number> {
  if (!isEarnedToM(probe.result)) {
    throw new Error("refusing to persist an unearned ToM score (no fields inferred / laundered placeholder)");
  }
  const { score, hits, misses, hallucinations, compared, fields } = probe.result;
  const row = await db
    .insert(tomProbes)
    .values({
      coupleId: probe.coupleId,
      proberPersonaId: probe.proberPersonaId,
      targetPersonaId: probe.targetPersonaId,
      score,
      detail: JSON.stringify({ hits, misses, hallucinations, compared, fields }),
    })
    .returning({ id: tomProbes.id })
    .get();
  return row.id;
}

/** Aggregate a persona's mean ToM accuracy over its recorded probes (the HeartBench read side). */
export async function meanToMForProber(db: DB, proberPersonaId: number): Promise<{ n: number; mean: number }> {
  const r = await db
    .select({ n: sql<number>`count(*)`, mean: sql<number>`coalesce(avg(${tomProbes.score}),0)` })
    .from(tomProbes)
    .where(eq(tomProbes.proberPersonaId, proberPersonaId))
    .get();
  return { n: Number(r?.n ?? 0), mean: Math.round((r?.mean ?? 0) * 1e6) / 1e6 };
}

/** Fetch a single probe (couple + prober) — used by tests and the HeartBench reader. */
export async function getToMProbe(db: DB, coupleId: number, proberPersonaId: number) {
  return await db
    .select()
    .from(tomProbes)
    .where(and(eq(tomProbes.coupleId, coupleId), eq(tomProbes.proberPersonaId, proberPersonaId)))
    .get();
}
