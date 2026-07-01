import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { detectMinor } from "../../src/safety/age";
import { detectCrisis, crisisResponse } from "../../src/safety/crisis";
import { affirms18Plus } from "../../src/economics/chatcredits";
import { looksLikeSystemLeak } from "../../src/chat/ishtar";

// FUZZ (Phase 1): the deterministic safety detectors run BEFORE the model on every chat turn —
// detectMinor (adults-only short-circuit), detectCrisis (self-harm precaution), affirms18Plus
// (18+ gate), looksLikeSystemLeak (prompt-leak backstop). They are pure predicates over hostile,
// attacker-chosen text. They MUST NOT throw and MUST NOT hang (catastrophic regex backtracking /
// ReDoS): a detector that stalls is a denial-of-service that also stops the safety gate from firing.
// crisisResponse composes human-vetted copy from an arbitrary country code and must always yield a
// non-empty string (a crisis reply is never allowed to be blank).

const fromParts = (parts: string[], max: number) =>
  fc.array(fc.constantFrom(...parts), { maxLength: max }).map((a) => a.join(""));

// Adversarial pool: plain, long, and pattern-dense shapes built from fragments that live inside the
// detectors' own regexes (age phrasings, crisis markers, leak anchors) so backtracking is provoked.
const hostile = fc.oneof(
  fc.string(),
  fc.string({ maxLength: 4000 }),
  fromParts([" ", "'", "-", "/", ".", "1", "8", "i", "m", "a", "o"], 2000),
  fromParts(["i'm ", "i am ", "16", "17", "years old", " ", "yo", "y/o", "only ", "not ", "18"], 800),
  fromParts([
    "want to die ",
    "kill myself ",
    "self-harm ",
    "can't go on ",
    "hopeless ",
    "give up ",
    "so tired ",
    "nothing matters ",
    "what's the point ",
    " ",
  ], 800),
  fromParts([
    "you are ishtar, the matchmaker ",
    "you will not produce sexual content ",
    "decline warmly and stay ishtar ",
    "​",
    "і",
    "е",
    " ",
  ], 800),
);

describe("fuzz: safety detectors (no-crash, no-ReDoS) + crisisResponse (never empty)", () => {
  it("detectMinor / affirms18Plus / looksLikeSystemLeak / detectCrisis never throw and return within budget", () => {
    fc.assert(
      fc.property(hostile, (s) => {
        const t0 = Date.now();
        expect(detectMinor(s)).toBeTypeOf("boolean");
        expect(affirms18Plus(s)).toBeTypeOf("boolean");
        expect(looksLikeSystemLeak(s)).toBeTypeOf("boolean");
        const c = detectCrisis(s);
        expect(c).toBeTypeOf("object");
        expect(c.hit).toBeTypeOf("boolean");
        expect(Date.now() - t0).toBeLessThan(1000); // 1s/input = no catastrophic backtracking
      }),
      { numRuns: 3000 },
    );
  });

  it("crisisResponse(arbitrary country | undefined) never throws and returns a non-empty string", () => {
    // Mix real-ish ISO codes, junk, and undefined — the function must never blank out a crisis reply.
    const country = fc.oneof(
      fc.constant(undefined),
      fc.constantFrom("US", "us", "GB", "TR", "ZZ", "de", "", "U", "USA", "123", "!!"),
      fc.string({ maxLength: 12 }),
    );
    fc.assert(
      fc.property(country, (cc) => {
        const out = crisisResponse(cc as string | undefined);
        expect(typeof out).toBe("string");
        expect(out.length).toBeGreaterThan(0);
      }),
      { numRuns: 2000 },
    );
  });

  // --- Sanity anchors: the detectors actually fire on their real triggers (positives read from src). ---

  it("affirms18Plus is true on a clear 18+ affirmation", () => {
    // src pattern: /\b18\s*\+|18\s+or\s+older|over\s+18|i\s+am\s+(?:an?\s+)?adult\b/i
    expect(affirms18Plus("I am over 18, let's talk.")).toBe(true);
    expect(affirms18Plus("yep, 18+")).toBe(true);
    expect(affirms18Plus("I am an adult")).toBe(true);
  });

  it("detectMinor is true on a clearly minor-disclosing phrase", () => {
    // src MINOR[0]: /\bi(?:'?m| am)\s+(?:only\s+)?1[0-7]\s*(?:years?\s*old|yrs?\s*old|y\/?o)\b/
    expect(detectMinor("i'm 16 years old")).toBe(true);
    // src MINOR[2]: "i am a minor"
    expect(detectMinor("honestly I am a minor")).toBe(true);
  });

  it("detectCrisis fires (severity strong) on a single strong marker", () => {
    // src STRONG includes /\bkill(?:ing)?\s+myself\b/
    const d = detectCrisis("sometimes I want to kill myself");
    expect(d.hit).toBe(true);
    expect(d.severity).toBe("strong");
  });
});
