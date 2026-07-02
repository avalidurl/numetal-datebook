import { describe, expect, it } from "vitest";
import { modelPool, pickDistinctModel, pickModel } from "../src/match/models";
import type { Env } from "../src/env";

// A couple is formed EXACTLY as StreamCoordinator.spawnCouple does it: pick A's model, then pick B's
// as a distinct model. These tests pin the P5 contract at the COUPLE level (two real, distinct models)
// plus the backward-compat fallback (empty pool → the single CHAT_MODEL, homogeneous but never broken).
const env = (MODEL_POOL?: string, CHAT_MODEL = "chat", GAMBIT_MODEL = "gambit"): Env =>
  ({ MODEL_POOL, CHAT_MODEL, GAMBIT_MODEL } as unknown as Env);

/** Form a couple's (modelA, modelB) the way the stream does. */
const coupleModels = (e: Env, aSeed: string, bSeed: string): [string, string] => {
  const a = pickModel(e, aSeed);
  const b = pickDistinctModel(e, bSeed, a);
  return [a, b];
};

describe("P5 heterogeneous-model couples", () => {
  it("a couple drawn from a multi-model pool gets two DISTINCT models (a real cross-model date)", () => {
    const e = env("m1,m2,m3,m4");
    // Every archetype-pair the stream might form must be cross-model.
    for (const [x, y] of [["wren", "cass"], ["ode", "bly"], ["rune", "sable"], ["mko", "vesper"], ["isole", "juno"]]) {
      const [a, b] = coupleModels(e, x!, y!);
      expect(a).not.toBe(b);
      expect(modelPool(e)).toContain(a);
      expect(modelPool(e)).toContain(b);
    }
  });

  it("assignment is deterministic per persona (Durable Object replay picks the same model)", () => {
    const e = env("m1,m2,m3");
    expect(pickModel(e, "wren")).toBe(pickModel(e, "wren"));
    expect(pickModel(e, 4242)).toBe(pickModel(e, 4242));
  });

  it("empty/unset MODEL_POOL falls back to CHAT_MODEL — backward compatible, homogeneous but never broken", () => {
    for (const raw of [undefined, "", "   ", ",", " , "]) {
      const e = env(raw);
      expect(modelPool(e)).toEqual(["chat"]);
      const [a, b] = coupleModels(e, "wren", "cass");
      expect(a).toBe("chat");
      expect(b).toBe("chat"); // single-model pool degrades gracefully (no distinct model to find)
    }
  });

  it("with no CHAT_MODEL it falls back to GAMBIT_MODEL (the stream's own fallback chain)", () => {
    const e = env(undefined, "", "gambit");
    expect(modelPool(e)).toEqual(["gambit"]);
    expect(pickModel(e, "wren")).toBe("gambit");
  });

  it("a two-model pool still yields a cross-model couple; a one-model pool cannot (and doesn't crash)", () => {
    const [a2, b2] = coupleModels(env("m1,m2"), "wren", "cass");
    expect(a2).not.toBe(b2);
    const [a1, b1] = coupleModels(env("solo"), "wren", "cass");
    expect(a1).toBe("solo");
    expect(b1).toBe("solo");
  });
});
