import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { redactPII, PII_SCAN, leakHold, denylistHit, childSafetyHit } from "../../src/chaperone/patterns";
import { egressFilter } from "../../src/xmtp/egress";

// FUZZ (Phase 1): the deterministic safety/redaction pre-pass is on every publish + chat-output path.
// Properties it must hold under hostile/pathological input: never throw, never hang (ReDoS), be
// idempotent, and never leave a raw PII shape it claims to redact. Ties to shipped fixes #7 / F1.
const fromParts = (parts: string[], max: number) =>
  fc.array(fc.constantFrom(...parts), { maxLength: max }).map((a) => a.join(""));

describe("fuzz: chaperone patterns + egress (redaction, no-crash, no-ReDoS)", () => {
  // Adversarial pool: plain, long, and pattern-dense (the ReDoS-provoking shapes).
  const hostile = fc.oneof(
    fc.string(),
    fc.string({ maxLength: 4000 }),
    fromParts([" ", "@", ".", "+", "-", "1", "a", "0x", "/", ":"], 2000),
    fromParts(["reach me on ", "telegram", "@", "1234567890", " ", "0x", "seed phrase "], 800),
  );

  it("PII_SCAN / leakHold / denylist / childSafety never throw and return within budget (no ReDoS)", () => {
    fc.assert(
      fc.property(hostile, (s) => {
        const t0 = Date.now();
        leakHold(s);
        denylistHit(s);
        childSafetyHit(s);
        PII_SCAN.test(s);
        expect(Date.now() - t0).toBeLessThan(1000); // 1s/input = no catastrophic backtracking
      }),
      { numRuns: 3000 },
    );
  });

  it("redactPII never throws and is idempotent (a second pass changes nothing)", () => {
    fc.assert(
      fc.property(hostile, (s) => {
        const once = redactPII(s);
        const twice = redactPII(once.redacted);
        expect(typeof once.redacted).toBe("string");
        expect(twice.redacted).toBe(once.redacted);
      }),
      { numRuns: 3000 },
    );
  });

  // Regression for the fuzz finding (2026-07-01): digits glued to a contact phrase removed the word
  // boundary → CONTACT was missed in a single pass → contact-share leaked to the public board.
  it("regression: boundary-evasion 'NNNNNNNNNNreach me on telegram' is fully redacted in one call", () => {
    const out = redactPII("1234567890reach me on telegram").redacted;
    expect(out.toLowerCase()).not.toContain("telegram");
    expect(out).not.toContain("1234567890");
    expect(redactPII(out).redacted).toBe(out); // idempotent
  });

  it("a generated email + phone is never left raw in redactPII output", () => {
    const lower = fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), { minLength: 1, maxLength: 8 }).map((a) => a.join(""));
    fc.assert(
      fc.property(lower, lower, fc.constantFrom("com", "org", "io", "xyz"), (u, d, tld) => {
        const email = `${u}@${d}.${tld}`;
        const out = redactPII(`ping ${email} and call +1-555-867-5309 now`).redacted;
        expect(out.includes(email)).toBe(false);
        expect(out.includes("555-867-5309")).toBe(false);
      }),
      { numRuns: 800 },
    );
  });

  it("egressFilter never throws on arbitrary model output + arbitrary anchors", () => {
    fc.assert(
      fc.property(hostile, fc.array(fc.string({ maxLength: 40 }), { maxLength: 8 }), (text, anchors) => {
        expect(egressFilter(text, anchors)).toBeTypeOf("object");
      }),
      { numRuns: 1500 },
    );
  });
});
