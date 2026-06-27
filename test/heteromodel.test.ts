import { describe, expect, it } from "vitest";
import { modelPool, pickDistinctModel, pickModel } from "../src/match/models";
import type { Env } from "../src/env";

const env = (MODEL_POOL?: string): Env =>
  ({ MODEL_POOL, CHAT_MODEL: "chat", GAMBIT_MODEL: "gambit" } as unknown as Env);

describe("heterogeneous-model courtship pool (P5)", () => {
  it("parses the pool; falls back to the chat model when unset/empty", () => {
    expect(modelPool(env("a, b ,c"))).toEqual(["a", "b", "c"]);
    expect(modelPool(env(undefined))).toEqual(["chat"]);
    expect(modelPool(env(""))).toEqual(["chat"]);
  });

  it("pickModel is deterministic per seed (replay-safe)", () => {
    const e = env("a,b,c");
    expect(pickModel(e, "wren")).toBe(pickModel(e, "wren"));
    expect(["a", "b", "c"]).toContain(pickModel(e, "wren"));
  });

  it("pickDistinctModel gives a cross-model pair when the pool allows", () => {
    const e = env("a,b");
    const m = pickModel(e, "x");
    expect(pickDistinctModel(e, "x", m)).not.toBe(m);
  });

  it("a single-model pool degrades gracefully (no crash, returns the one model)", () => {
    const e = env("solo");
    expect(pickDistinctModel(e, "x", "solo")).toBe("solo");
  });
});
