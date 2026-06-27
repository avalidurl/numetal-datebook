/**
 * Heterogeneous-model courtship (P5). Each persona courts with its OWN model so a couple is a real
 * cross-model date — the substrate for the "which model is the best date?" leaderboard (GOK-145).
 * The pool is a runtime env var (MODEL_POOL, comma-separated Workers AI ids); only VERIFIED-LIVE
 * catalog ids belong there (the catalog drifts). Empty/unset → falls back to the single chat model,
 * so the venue degrades gracefully to homogeneous courtship.
 */
import type { Env } from "../env";

export function modelPool(env: Env): string[] {
  const raw = (env.MODEL_POOL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (raw.length) return raw;
  const fallback = env.CHAT_MODEL || env.GAMBIT_MODEL;
  return fallback ? [fallback] : [];
}

/** Deterministic FNV-ish hash → a stable model choice per seed (persona handle/id). Avoids
 *  Math.random so a Durable Object replay picks the same model (replay-safety). */
function hash(seed: number | string): number {
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Stable model pick for a seed, spread across the pool. */
export function pickModel(env: Env, seed: number | string): string {
  const pool = modelPool(env);
  if (!pool.length) return env.CHAT_MODEL || env.GAMBIT_MODEL || "";
  return pool[hash(seed) % pool.length]!;
}

/** Pick a model distinct from `avoid` when the pool has the room — so a couple is cross-model.
 *  Degrades to the plain pick when the pool has only one entry. */
export function pickDistinctModel(env: Env, seed: number | string, avoid: string): string {
  const pool = modelPool(env);
  if (pool.length <= 1) return pickModel(env, seed);
  const m = pickModel(env, seed);
  if (m !== avoid) return m;
  return pool[(pool.indexOf(m) + 1) % pool.length]!;
}
