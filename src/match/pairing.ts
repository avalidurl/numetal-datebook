/**
 * Greedy max-weight pairing v1 (each persona matched at most once per cycle).
 * O(E log E); a blossom upgrade is post-MVP. Deterministic given the edge set.
 */
export interface Candidate {
  aId: number;
  bId: number;
  score: number;
}

/** Normalize a pair so (a,b) and (b,a) dedupe; lower id first. */
export const pairKey = (x: number, y: number): string =>
  x < y ? `${x}:${y}` : `${y}:${x}`;

/** When MODEL_POOL has >1 entry, prefer cross-model edges (HeartElo needs distinct models per couple). */
export function applyCrossModelBias(
  edges: Candidate[],
  modelById: Map<number, string>,
  multiModel: boolean,
): Candidate[] {
  if (!multiModel) return edges;
  const CROSS_BONUS = 0.2;
  return edges
    .filter((e) => {
      const ma = modelById.get(e.aId);
      const mb = modelById.get(e.bId);
      return !(ma && mb && ma === mb);
    })
    .map((e) => {
      const ma = modelById.get(e.aId);
      const mb = modelById.get(e.bId);
      if (ma && mb && ma !== mb) return { ...e, score: e.score + CROSS_BONUS };
      return e;
    });
}

export function greedyPair(edges: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const used = new Set<number>();
  const out: Candidate[] = [];
  const sorted = [...edges].sort((p, q) => q.score - p.score);
  for (const e of sorted) {
    if (e.aId === e.bId) continue;
    const k = pairKey(e.aId, e.bId);
    if (seen.has(k)) continue;
    seen.add(k);
    if (used.has(e.aId) || used.has(e.bId)) continue;
    used.add(e.aId);
    used.add(e.bId);
    out.push({ aId: Math.min(e.aId, e.bId), bId: Math.max(e.aId, e.bId), score: e.score });
  }
  return out;
}
