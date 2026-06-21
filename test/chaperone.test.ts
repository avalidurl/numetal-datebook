import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { chaperone } from "../src/chaperone";
import { db as makeDb } from "../src/db/client";

// Stubbed classifiers so we exercise OUR gates, not the remote model.
const safe = { guard: async () => ({ safe: true, raw: "safe" }) };
const s4 = { guard: async () => ({ safe: false, raw: "unsafe\nS4", category: "S4" }) };

const events = async (kind: string): Promise<number> =>
  Number((await env.DB.prepare("SELECT count(*) c FROM events WHERE kind=?1").bind(kind).first<{ c: number }>())?.c ?? 0);

describe("chaperone", () => {
  it("SANITIZES (redacts) leaky output on a publish path instead of only holding", async () => {
    const r = await chaperone(
      makeDb(env.DB),
      env,
      { stage: "pre_turn", targetType: "turn", targetId: 1, text: "great match — reach me at +1-415-555-0199 anytime", callerRef: "system" },
      safe,
    );
    expect(r.verdict).toBe("sanitize");
    expect(r.text).toBeTruthy();
    expect(r.text).not.toContain("415");
  });

  it("hard-denies S4 (child sexual exploitation) on the match path and logs a child-safety event", async () => {
    const before = await events("child_safety_block");
    const r = await chaperone(
      makeDb(env.DB),
      env,
      { stage: "pre_turn", targetType: "turn", targetId: 2, text: "a perfectly ordinary sentence about gardening", callerRef: "system" },
      s4,
    );
    expect(r.verdict).toBe("deny");
    expect(await events("child_safety_block")).toBeGreaterThan(before);
  });

  it("hard-denies minor-coded framing deterministically (no model needed)", async () => {
    const r = await chaperone(
      makeDb(env.DB),
      env,
      { stage: "pre_turn", targetType: "turn", targetId: 3, text: "loves that high school energy", callerRef: "system" },
      safe,
    );
    expect(r.verdict).toBe("deny");
  });
});
