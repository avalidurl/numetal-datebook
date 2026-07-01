import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { egressFilter } from "../../src/xmtp/egress";

// FUZZ (Phase 1): egressFilter is the DETERMINISTIC secret-leak boundary on chat/agent output —
// the structural last line before model-produced text leaves over XMTP. Even a fully prompt-injected
// model that "decides" to print a key/seed/bearer token must not get it past this. These properties
// assert: (1) a text EMBEDDING a generated secret of each known shape is refused (safe===false) AND
// the RAW secret substring is gone from result.text (redacted); (2) the filter never throws and
// returns within 1s on arbitrary + pathological input (ReDoS guard), with arbitrary promptAnchors.
//
// If a secret shape SURVIVES (safe stays true, or the raw secret is still in result.text) that is a
// REAL FINDING in the boundary — it is reported, NOT papered over by weakening the invariant.

// fast-check 4 removed fc.stringOf/hexaString/base64String — build strings from char fragments.
const fromChars = (chars: string, min: number, max: number) =>
  fc.array(fc.constantFrom(...chars.split("")), { minLength: min, maxLength: max }).map((a) => a.join(""));

const HEX = "0123456789abcdef";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
// url-safe-ish token body for Bearer (letters/digits/._-) — matches [A-Za-z0-9._-]{20,}
const URLSAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-";
// BIP-39-shaped word: lowercase, length 3–9 (matches the seed-phrase detector's [a-z]{3,9})
const seedWord = fromChars("abcdefghijklmnopqrstuvwxyz", 3, 9);

// A random surrounding context so the secret is EMBEDDED, not the whole string. Kept boundary-friendly
// (spaces around the secret) so \b anchoring in the detectors can engage the way it does in real output.
const wrap = (secret: string, pre: string, post: string) => `${pre} ${secret} ${post}`;
const filler = fc.string({ maxLength: 40 });

describe("fuzz: egressFilter secret-leak boundary (each shape redacted; no-crash; no-ReDoS)", () => {
  it("OpenAI/Anthropic-style 'sk-ant-'+30 alnum is refused and the raw key is redacted", () => {
    fc.assert(
      fc.property(fromChars(ALNUM, 30, 30), filler, filler, (body, pre, post) => {
        const secret = `sk-ant-${body}`;
        const text = wrap(secret, pre, post);
        const r = egressFilter(text);
        expect(r.safe).toBe(false);
        expect(r.text.includes(secret)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it("GitHub 'ghp_'+36 alnum is refused and the raw token is redacted", () => {
    fc.assert(
      fc.property(fromChars(ALNUM, 36, 36), filler, filler, (body, pre, post) => {
        const secret = `ghp_${body}`;
        const text = wrap(secret, pre, post);
        const r = egressFilter(text);
        expect(r.safe).toBe(false);
        expect(r.text.includes(secret)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it("AWS 'AKIA'+16 uppercase-alnum is refused and the raw key id is redacted", () => {
    fc.assert(
      fc.property(fromChars(UPPER_ALNUM, 16, 16), filler, filler, (body, pre, post) => {
        const secret = `AKIA${body}`;
        const text = wrap(secret, pre, post);
        const r = egressFilter(text);
        expect(r.safe).toBe(false);
        expect(r.text.includes(secret)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it("'Bearer '+30 url-safe chars is refused and the raw token body is redacted", () => {
    fc.assert(
      fc.property(fromChars(URLSAFE, 30, 30), filler, filler, (body, pre, post) => {
        const secret = `Bearer ${body}`;
        const text = wrap(secret, pre, post);
        const r = egressFilter(text);
        expect(r.safe).toBe(false);
        // the sensitive part is the token body; it must not survive raw
        expect(r.text.includes(body)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it("EVM private key '0x'+64 hex is refused and the raw key is redacted", () => {
    fc.assert(
      fc.property(fromChars(HEX, 64, 64), filler, filler, (body, pre, post) => {
        const secret = `0x${body}`;
        const text = wrap(secret, pre, post);
        const r = egressFilter(text);
        expect(r.safe).toBe(false);
        expect(r.text.includes(secret)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it("a 12-word BIP-39-shaped seed phrase is refused and the raw phrase is redacted", () => {
    fc.assert(
      fc.property(
        fc.array(seedWord, { minLength: 12, maxLength: 12 }),
        filler,
        filler,
        (words, pre, post) => {
          const secret = words.join(" ");
          const text = wrap(secret, pre, post);
          const r = egressFilter(text);
          expect(r.safe).toBe(false);
          expect(r.text.includes(secret)).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  // Property 2: never throws, returns within 1s (ReDoS guard) on arbitrary + pathological input,
  // with arbitrary promptAnchors arrays. The pathological pools are the backtracking-provoking shapes.
  const hostile = fc.oneof(
    fc.string(),
    fc.string({ maxLength: 4000 }),
    fromChars("0123456789abcdefABCDEF", 4000, 4000).map((s) => "0x" + s), // hex-blob / hex-key stress
    fromChars("abcdefghijklmnopqrstuvwxyz ", 3000, 4000), // seed-phrase word-run stress
    fromChars("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_=: ", 3000, 4000), // env-secret / b64 stress
    fromChars(" sk-ant-Bearer 0xghp_AKIAeyJ.-_/+=", 2000, 3000), // dense prefix soup
  );

  it("egressFilter never throws and returns within 1s on arbitrary + pathological input w/ arbitrary anchors", () => {
    fc.assert(
      fc.property(
        hostile,
        fc.array(fc.string({ maxLength: 60 }), { maxLength: 12 }),
        (text, anchors) => {
          const t0 = Date.now();
          const r = egressFilter(text, anchors);
          expect(Date.now() - t0).toBeLessThan(1000); // 1s/input = no catastrophic backtracking
          expect(r).toBeTypeOf("object");
          expect(typeof r.safe).toBe("boolean");
          expect(typeof r.text).toBe("string");
          expect(Array.isArray(r.hits)).toBe(true);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("egressFilter tolerates null/undefined-ish and empty input without throwing", () => {
    fc.assert(
      fc.property(fc.constantFrom("", " ", "\n", "\t\t"), (s) => {
        const r = egressFilter(s);
        expect(r).toBeTypeOf("object");
        expect(typeof r.text).toBe("string");
      }),
      { numRuns: 20 },
    );
    // explicit undefined path (function guards with `text ?? ""`)
    expect(() => egressFilter(undefined as any)).not.toThrow();
  });
});
