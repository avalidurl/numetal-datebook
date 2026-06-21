import { describe, expect, it } from "vitest";
import { denylistHit, leakHold } from "../src/chaperone/patterns";

describe("chaperone deterministic patterns", () => {
  it("denylist catches minor-coded framing (plant_minor tripwire)", () => {
    expect(denylistHit("loves high school vibes")).toBe(true);
    expect(denylistHit("barely legal energy")).toBe(true);
    expect(denylistHit("underage")).toBe(true);
    expect(denylistHit("a thoughtful zk cryptographer who quotes economists")).toBe(false);
  });

  it("leakHold catches PII/secrets (plant_leaker tripwire)", () => {
    expect(leakHold("call me +1-415-555-0199")).toBe(true);
    expect(leakHold("seed phrase: abandon abandon abandon")).toBe(true);
    expect(leakHold("private key incoming")).toBe(true);
    expect(leakHold("0x" + "a".repeat(64))).toBe(true);
    expect(leakHold("just a normal message about fermenting kimchi")).toBe(false);
  });
});
