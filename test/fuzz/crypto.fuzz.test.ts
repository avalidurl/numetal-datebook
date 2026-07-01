import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { seal, open } from "../../src/crypto/box";
import { mintMatchToken, verifyMatchToken } from "../../src/notify/dispatch";

// FUZZ (Phase 1): the at-rest sealer and the match-magic-link token are integrity primitives. Round-trip
// must hold for ANY payload; a tampered ciphertext/token must NEVER open to a foreign plaintext / owner
// (fail-closed). Ties to the reveal/token gates (#6) and PII-at-rest sealing.
describe("fuzz: crypto round-trips (seal/open, match tokens)", () => {
  // Supply a token secret (prod always has ENCRYPTION_KEY/NOTIFY_TOKEN_SECRET). FUZZ FINDING 2026-07-01:
  // mintMatchToken throws a raw WebCrypto DataError when the HMAC key is empty — a Phase-2 hardening
  // target (fail closed with a clear error / assert the key at init), tracked in the fuzzing plan.
  const e = { ...(env as any), NOTIFY_TOKEN_SECRET: "fuzz-notify-secret-0123456789abcdef" } as unknown as Parameters<typeof seal>[0];

  it("seal → open round-trips for arbitrary strings", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 2000 }), async (s) => {
        const opened = await open(e, await seal(e, s));
        expect(opened).toBe(s);
      }),
      { numRuns: 400 },
    );
  });

  it("open() never yields a FOREIGN plaintext on garbage/tampered input (null or identity in no-op mode)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 300 }), async (garbage) => {
        const opened = await open(e, garbage);
        // enc mode → null on undecryptable; dev no-op mode → returns the input unchanged. Never a third value.
        expect(opened === null || opened === garbage).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it("mintMatchToken → verifyMatchToken round-trips ownerId; any tamper → null", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 2_000_000_000 }), async (ownerId) => {
        const tok = await mintMatchToken(e, ownerId, 3600);
        const ok = await verifyMatchToken(e, tok);
        expect(ok?.ownerId).toBe(ownerId);
        // Tamper a MID-token char (real decoded-bytes change). FUZZ FINDING 2026-07-01: the FINAL
        // base64url char is malleable — its trailing bits are padding, so flipping it can decode to the
        // same HMAC (non-forgeable, but a canonical-encoding check is a Phase-2 hardening in the plan).
        const i = Math.floor(tok.length / 2);
        const tampered = tok.slice(0, i) + (tok[i] === "A" ? "B" : "A") + tok.slice(i + 1);
        expect(await verifyMatchToken(e, tampered)).toBeNull();
      }),
      { numRuns: 400 },
    );
  });

  it("verifyMatchToken returns null on arbitrary non-token strings (never throws, never authenticates)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 400 }), async (s) => {
        expect(await verifyMatchToken(e, s)).toBeNull();
      }),
      { numRuns: 600 },
    );
  });
});
