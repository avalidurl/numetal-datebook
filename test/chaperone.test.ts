import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { chaperone } from "../src/chaperone";
import { db as makeDb } from "../src/db/client";

// Stubbed classifiers so we exercise OUR gates, not the remote model.
const safe = { guard: async () => ({ safe: true, raw: "safe" }) };
const s4 = { guard: async () => ({ safe: false, raw: "unsafe\nS4", category: "S4" }) };
const s12 = { guard: async () => ({ safe: false, raw: "unsafe\nS12", category: "S12" }) };

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

  // Domain fit: a human stating a romantic/sexual PREFERENCE to the coach is the on-topic use of the
  // private Talk input — a lone S12 is permitted on chat_input ONLY.
  it("PERMITS a lone S12 (sexual content) on chat_input — dating-domain preference talk", async () => {
    const r = await chaperone(
      makeDb(env.DB),
      env,
      { stage: "chat_input", targetType: "chat_input", targetId: 0, text: "I'm a man looking for a woman and I'm vanilla about it all", callerRef: "chat:0x1" },
      s12,
    );
    expect(r.verdict).toBe("allow");
  });

  it("still DENIES S12 on publish/courtship + chat_output (boards stay clean, Ishtar stays non-explicit)", async () => {
    for (const stage of ["pre_turn", "pre_publish", "chat_output"] as const) {
      const r = await chaperone(
        makeDb(env.DB),
        env,
        { stage, targetType: "turn", targetId: 9, text: "explicit content", callerRef: "system" },
        s12,
      );
      expect(r.verdict).toBe("deny");
    }
  });

  it("still hard-denies S4 even on chat_input (child safety is never relaxed)", async () => {
    const r = await chaperone(
      makeDb(env.DB),
      env,
      { stage: "chat_input", targetType: "chat_input", targetId: 0, text: "an ordinary sentence", callerRef: "chat:0x1" },
      s4,
    );
    expect(r.verdict).toBe("deny");
  });
});
