import { describe, expect, it } from "vitest";
import { greedyPair, pairKey } from "../src/match/pairing";

describe("greedy pairing", () => {
  it("matches each persona at most once, highest score first", () => {
    const pairs = greedyPair([
      { aId: 1, bId: 2, score: 0.9 },
      { aId: 1, bId: 3, score: 0.8 },
      { aId: 2, bId: 3, score: 0.5 },
      { aId: 4, bId: 3, score: 0.7 },
    ]);
    expect(pairs).toHaveLength(2); // 1-2 (0.9) then 4-3 (0.7)
    expect(pairs[0]).toMatchObject({ aId: 1, bId: 2 });
    const used = pairs.flatMap((p) => [p.aId, p.bId]);
    expect(new Set(used).size).toBe(used.length); // no persona twice
  });

  it("dedupes symmetric edges", () => {
    expect(pairKey(2, 1)).toBe(pairKey(1, 2));
    expect(greedyPair([
      { aId: 1, bId: 2, score: 0.5 },
      { aId: 2, bId: 1, score: 0.9 },
    ])).toHaveLength(1);
  });
});
