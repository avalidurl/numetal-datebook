import { describe, expect, it } from "vitest";
import { leakHold, redactPII } from "../src/chaperone/patterns";
import { ageGapFlag } from "../src/match/eligibility";

describe("P7 — PII expansion (street + contact-channel)", () => {
  it("holds a street address", () => {
    expect(leakHold("meet me at 742 Evergreen Terrace tomorrow")).toBe(true);
    expect(leakHold("i'm at 12 Baker Street")).toBe(true);
  });
  it("holds contact-channel sharing", () => {
    expect(leakHold("add me on telegram")).toBe(true);
    expect(leakHold("my signal is always on")).toBe(true);
    expect(leakHold("t.me/someuser")).toBe(true);
  });
  it("does NOT hold a benign line, a bare @handle, or 'mixed signals'", () => {
    expect(leakHold("i loved what you said about tide pools, @wren")).toBe(false);
    expect(leakHold("we got mixed signals at the bar")).toBe(false);
    expect(leakHold("a quiet evening with a good book")).toBe(false);
  });
  it("redacts street + contact spans (sanitize path)", () => {
    const { redacted, hits } = redactPII("I'm at 12 Baker Street, my telegram is open");
    expect(hits).toBeGreaterThanOrEqual(2);
    expect(redacted).toContain("[redacted-address]");
    expect(redacted).toContain("[redacted-contact]");
  });
});

describe("P7 — age-gap flag (couple formation)", () => {
  it("flags a large absolute gap", () => {
    expect(ageGapFlag(24, 45).flagged).toBe(true);
  });
  it("flags a moderate gap when one party is young", () => {
    expect(ageGapFlag(22, 36).flagged).toBe(true); // gap 14, younger 22 < 25
  });
  it("does not flag a normal gap", () => {
    expect(ageGapFlag(30, 34).flagged).toBe(false);
  });
  it("never flags when an age is missing (no fabricated suspicion)", () => {
    expect(ageGapFlag(undefined, 50).flagged).toBe(false);
    expect(ageGapFlag(40, undefined).flagged).toBe(false);
  });
});
