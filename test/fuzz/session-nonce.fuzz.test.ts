import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { db as makeDb } from "../../src/db/client";
import { mintNonce, consumeNonce, mintSession, resolveSession } from "../../src/economics/chatcredits";

// FUZZ (Phase 1): sign-in nonces + bearer sessions are the AUTH boundary. Two invariants that must
// hold under any input: (1) a minted nonce is strictly single-use (anti-replay) and a never-minted
// nonce is NEVER accepted (anti-forgery); (2) a bearer token round-trips to its own (lowercased)
// address and NO garbage token ever resolves to a foreign address (fail-closed → null). Ties to
// mintNonce/consumeNonce (single-use UPDATE guard) + mintSession/resolveSession (SHA-256 hash store).
const db = makeDb((env as any).DB);

// A fresh, canonical-lowercase EVM-style address per run: "0x" + 40 hex chars.
const hexChar = fc.constantFrom(..."0123456789abcdef".split(""));
const addrArb = fc.array(hexChar, { minLength: 40, maxLength: 40 }).map((a) => "0x" + a.join(""));

describe("fuzz: sign-in nonces + bearer sessions (single-use, fail-closed)", () => {
  it("prop1: a minted nonce is single-use — first consume true, second consume false", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const n = await mintNonce(db);
        const first = await consumeNonce(db, n);
        const second = await consumeNonce(db, n);
        expect(first).toBe(true); // valid, unused, fresh → accepted exactly once
        expect(second).toBe(false); // replay of the SAME nonce → rejected (anti-replay)
      }),
      { numRuns: 25 },
    );
  });

  it("prop2: a never-minted nonce (arbitrary string) is never accepted", async () => {
    // Mix of pure garbage AND plausible-looking random hex (which passes the shape regex but was
    // never inserted) — both must fail-closed. If any random string consumes, that's a forged auth.
    const garbage = fc.oneof(
      fc.string({ maxLength: 80 }),
      fc.array(hexChar, { minLength: 16, maxLength: 64 }).map((a) => a.join("")), // valid-shape, never minted
      fc.constant(""),
      fc.constant("0".repeat(32)),
    );
    await fc.assert(
      fc.asyncProperty(garbage, async (tok) => {
        const ok = await consumeNonce(db, tok);
        expect(ok).toBe(false);
      }),
      { numRuns: 60 },
    );
  });

  it("prop3: a minted session round-trips to its OWN lowercased address; garbage tokens resolve to null", async () => {
    await fc.assert(
      fc.asyncProperty(addrArb, async (addr) => {
        const { token } = await mintSession(db, addr, "signature");
        const resolved = await resolveSession(db, token);
        // resolveSession returns the stored address, which mintSession lowercases via lc(addr).
        expect(resolved).toBe(addr.toLowerCase());
      }),
      { numRuns: 25 },
    );
  });

  it("prop3b: no garbage token ever resolves to an address (never a foreign address)", async () => {
    // Seed a real session so the table is non-empty — a forged token must still miss it.
    const seed = await mintSession(db, "0x" + "a".repeat(40), "signature");
    const seedAddr = "0x" + "a".repeat(40);
    // Sanity: the real token resolves; garbage must not.
    expect(await resolveSession(db, seed.token)).toBe(seedAddr);

    const garbageToken = fc.oneof(
      fc.string({ maxLength: 120 }), // arbitrary junk
      fc.array(hexChar, { minLength: 64, maxLength: 64 }).map((a) => "ish_" + a.join("")), // right prefix, wrong hash
      fc.constant("ish_"),
      fc.constant("ish_deadbeef"),
      fc.constant(""),
      fc.constant(seed.token + "x"), // near-miss on a real token
    );
    await fc.assert(
      fc.asyncProperty(garbageToken, async (tok) => {
        // Skip the (astronomically unlikely) case where the fuzzer regenerates the exact real token.
        if (tok === seed.token) return;
        const r = await resolveSession(db, tok);
        expect(r).toBeNull(); // fail-closed: never returns ANY address for an unknown token
      }),
      { numRuns: 60 },
    );
  });
});
