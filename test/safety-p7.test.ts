import { describe, expect, it } from "vitest";
import { leakHold, redactPII } from "../src/chaperone/patterns";

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
