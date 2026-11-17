import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { db as makeDb } from "../src/db/client";
import { couples, heartFiles, identityVerifications, introConsents, owners, personas } from "../src/db/schema";
import { mintMatchToken, verifyMatchToken } from "../src/crypto/matchtoken";
import { listMatchesForOwner } from "../src/routes/matches";
import type { Env } from "../src/env";

// AUTHORITATIVE token scheme (the NOTIFY branch mints; we verify). Signs with NOTIFY_TOKEN_SECRET ||
// ENCRYPTION_KEY (verbatim UTF-8). The test env ships neither, so we set ENCRYPTION_KEY for these tests
// and restore it after, exactly like box.test builds a keyed env.
const TEST_KEY = "test-encryption-key-for-match-tokens-do-not-use-in-prod";
const keyedEnv = { ENCRYPTION_KEY: TEST_KEY } as unknown as Env;

const rnd = () => Math.random().toString(36).slice(2);

const b64urlEnc = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDec = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

/**
 * Mint a token EXACTLY as the notify branch does — the authoritative wire scheme — so these tests prove
 * our verifier accepts what notify produces (not just what our own mintMatchToken produces). Lets us
 * also forge arbitrary exp / ownerId for the expiry + tamper cases.
 *   token = "v1." + base64url(utf8(JSON.stringify({o, exp}))) + "." + base64url(HMAC_SHA256(key, "v1."+body64))
 */
async function notifyMint(key: string, ownerId: number, exp: number): Promise<string> {
  const enc = new TextEncoder();
  const body64 = b64urlEnc(enc.encode(JSON.stringify({ o: ownerId, exp }))); // KEY ORDER {o, exp}
  const signedInput = `v1.${body64}`; // the signed input INCLUDES the "v1." prefix
  const ck = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", ck, enc.encode(signedInput)));
  return `${signedInput}.${b64urlEnc(sig)}`;
}
const futureExp = () => Math.floor(Date.now() / 1000) + 1000;

describe("match token (mint / verify)", () => {
  it("round-trips: a freshly minted token verifies back to its ownerId (v1. three-part scheme)", async () => {
    const token = await mintMatchToken(keyedEnv, 42);
    expect(token).toBeTruthy();
    const parts = token!.split(".");
    expect(parts).toHaveLength(3); // "v1" . body64 . sig64
    expect(parts[0]).toBe("v1");
    const v = await verifyMatchToken(keyedEnv, token!);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.ownerId).toBe(42);
  });

  it("accepts a token minted by the AUTHORITATIVE notify scheme byte-for-byte (ownerId read from `o`)", async () => {
    // Hand-built with notify's exact bytes — proves cross-branch compatibility, not just self-consistency.
    const token = await notifyMint(TEST_KEY, 314, futureExp());
    const v = await verifyMatchToken(keyedEnv, token);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.ownerId).toBe(314);
  });

  it("NOTIFY_TOKEN_SECRET takes precedence over ENCRYPTION_KEY when both are set", async () => {
    const both = { NOTIFY_TOKEN_SECRET: "notify-secret", ENCRYPTION_KEY: "enc-key" } as unknown as Env;
    // A token signed with the NOTIFY secret verifies; one signed with the ENCRYPTION key does NOT.
    expect((await verifyMatchToken(both, await notifyMint("notify-secret", 5, futureExp()))).ok).toBe(true);
    expect((await verifyMatchToken(both, await notifyMint("enc-key", 5, futureExp()))).ok).toBe(false);
  });

  it("falls back to ENCRYPTION_KEY when NOTIFY_TOKEN_SECRET is unset", async () => {
    const v = await verifyMatchToken(keyedEnv, await notifyMint(TEST_KEY, 9, futureExp()));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.ownerId).toBe(9);
  });

  it("is fail-closed when NO signing key is set: cannot mint, cannot verify", async () => {
    const noKey = {} as unknown as Env;
    expect(await mintMatchToken(noKey, 1)).toBeNull();
    const v = await verifyMatchToken(noKey, await notifyMint(TEST_KEY, 1, futureExp()));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("unconfigured");
  });

  it("rejects an EXPIRED token even with a valid signature", async () => {
    const token = await notifyMint(TEST_KEY, 7, Math.floor(Date.now() / 1000) - 10); // exp 10s ago
    const v = await verifyMatchToken(keyedEnv, token);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("expired");
  });

  it("the minter never emits an already-expired token (TTL is clamped ≥ 1s)", async () => {
    const token = await mintMatchToken(keyedEnv, 7, -10); // negative TTL clamped up
    expect((await verifyMatchToken(keyedEnv, token!)).ok).toBe(true);
  });

  it("rejects a TAMPERED body (any byte flipped invalidates the MAC) — constant-time compare", async () => {
    const token = await notifyMint(TEST_KEY, 7, futureExp());
    const [, body64, sig64] = token.split(".") as [string, string, string];
    // Re-encode a body claiming ownerId 999 but keep the original signature → must fail.
    const forgedBody = b64urlEnc(new TextEncoder().encode(JSON.stringify({ o: 999, exp: futureExp() })));
    const v = await verifyMatchToken(keyedEnv, `v1.${forgedBody}.${sig64}`);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("bad_signature");
    // Sanity: the untouched token still verifies (so the rig isn't accidentally rejecting everything).
    expect((await verifyMatchToken(keyedEnv, `v1.${body64}.${sig64}`)).ok).toBe(true);
  });

  it("rejects a TAMPERED signature", async () => {
    const token = await notifyMint(TEST_KEY, 7, futureExp());
    const [, body64, sig64] = token.split(".") as [string, string, string];
    const sig = b64urlDec(sig64);
    sig[0] = sig[0]! ^ 0xff; // flip a real byte
    const v = await verifyMatchToken(keyedEnv, `v1.${body64}.${b64urlEnc(sig)}`);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("bad_signature");
  });

  it("rejects a WRONG version prefix even with an otherwise-valid body+sig", async () => {
    const token = await notifyMint(TEST_KEY, 7, futureExp());
    const [, body64, sig64] = token.split(".") as [string, string, string];
    const v = await verifyMatchToken(keyedEnv, `v2.${body64}.${sig64}`); // version changed → reject
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("malformed");
  });

  it("rejects a token signed with a DIFFERENT key (forgery under the wrong secret)", async () => {
    const token = await notifyMint("another-secret", 7, futureExp());
    const v = await verifyMatchToken(keyedEnv, token); // verify under TEST_KEY → mismatch
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("bad_signature");
  });

  it("rejects structurally malformed tokens", async () => {
    for (const bad of ["", "no-dot-here", "v1.only", "v1.", ".a.b", "a.b.c.d", "x.y.z"]) {
      const v = await verifyMatchToken(keyedEnv, bad);
      expect(v.ok).toBe(false);
    }
  });
});

describe("GET /api/matches — magic-link your-matches read", () => {
  let savedKey: string | undefined;
  // owner A (the token holder) ↔ owner B (the match). plus a THIRD owner C with its own couple,
  // to prove A's token never leaks C's couples.
  let oA = 0, oB = 0, oC = 0, oD = 0;
  let coupleAB = 0, coupleCD = 0;

  async function get(path: string): Promise<Response> {
    const ctx = createExecutionContext();
    const r = await worker.fetch(new Request("https://d" + path, { headers: { accept: "application/json" }, cf: { country: "US" } }), env, ctx);
    await waitOnExecutionContext(ctx);
    return r;
  }

  beforeEach(async () => {
    // Light up the token scheme on the live worker env for this block; restore in afterEach.
    savedKey = (env as Env).ENCRYPTION_KEY;
    (env as unknown as { ENCRYPTION_KEY: string }).ENCRYPTION_KEY = TEST_KEY;

    for (const t of ["identity_verifications", "intro_consents", "heart_files", "couples", "personas", "owners"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    const db = makeDb(env.DB);
    const mkOwner = async (contact: string, tier = "agent_represented") =>
      (await db.insert(owners).values({ contactRef: contact, tier }).returning({ id: owners.id }).get()).id;
    oA = await mkOwner("contact@gokhan.vc");
    oB = await mkOwner("tg:@bob_secret");
    oC = await mkOwner("contact@gokhan.vc");
    oD = await mkOwner("contact@gokhan.vc");

    const mkPersona = async (ownerId: number) =>
      (await db.insert(personas).values({ ownerId, handle: "h" + rnd(), model: "m", heartJson: "{}", personaAge: "18+", status: "admitted" }).returning({ id: personas.id }).get()).id;
    const pA = await mkPersona(oA);
    const pB = await mkPersona(oB);
    const pC = await mkPersona(oC);
    const pD = await mkPersona(oD);

    // B exposes a chaperoned public summary; it MUST surface to A (it's public-safe).
    await db.insert(heartFiles).values({ ownerId: oB, personaId: pB, bodyJson: "{}", publicSummary: "writes long, argues kindly", status: "admitted" }).run();

    coupleAB = (await db.insert(couples).values({ cycleId: "t", aId: pA, bId: pB, state: "courting" }).returning({ id: couples.id }).get()).id;
    coupleCD = (await db.insert(couples).values({ cycleId: "t", aId: pC, bId: pD, state: "committed" }).returning({ id: couples.id }).get()).id;
  });

  afterEach(() => {
    if (savedKey === undefined) delete (env as unknown as { ENCRYPTION_KEY?: string }).ENCRYPTION_KEY;
    else (env as unknown as { ENCRYPTION_KEY: string }).ENCRYPTION_KEY = savedKey;
  });

  it("returns ONLY the token-owner's couples (no enumeration of other owners')", async () => {
    const token = await mintMatchToken(keyedEnv, oA);
    const r = await get(`/api/matches?token=${encodeURIComponent(token!)}`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; matches: Array<{ coupleId: number; otherPublicSummary: { handle: string | null; summary: string | null }; contact: string | null; revealUnlocked: boolean }> };
    expect(j.ok).toBe(true);
    expect(j.matches).toHaveLength(1); // A is only in coupleAB — coupleCD must NOT appear
    expect(j.matches[0]!.coupleId).toBe(coupleAB);
    expect(j.matches[0]!.otherPublicSummary.summary).toBe("writes long, argues kindly");
  });

  it("WITHHOLDS contact until the reveal gate clears (locked → contact:null, never B's contactRef)", async () => {
    const token = await mintMatchToken(keyedEnv, oA);
    const j = (await (await get(`/api/matches?token=${encodeURIComponent(token!)}`)).json()) as { matches: Array<{ contact: string | null; revealUnlocked: boolean }> };
    expect(j.matches[0]!.revealUnlocked).toBe(false);
    expect(j.matches[0]!.contact).toBeNull();
    // The whole JSON body must not contain B's secret contact pre-reveal.
    expect(JSON.stringify(j)).not.toContain("bob_secret");
  });

  it("REVEALS contact only when both owners are identity_verified + 18+ + both consented (revealReady)", async () => {
    const db = makeDb(env.DB);
    // Flip both owners to identity_verified + record 18+ + both consent → revealReady becomes true.
    for (const id of [oA, oB]) {
      await db.update(owners).set({ tier: "identity_verified" }).where(eq(owners.id, id)).run();
      await db.insert(identityVerifications).values({ ownerId: id, status: "verified", ageOver18: 1 }).run();
      await db.insert(introConsents).values({ coupleId: coupleAB, ownerId: id, consentKind: "contact_reveal", status: "accepted" }).run();
    }
    const token = await mintMatchToken(keyedEnv, oA);
    const j = (await (await get(`/api/matches?token=${encodeURIComponent(token!)}`)).json()) as { matches: Array<{ contact: string | null; revealUnlocked: boolean }> };
    expect(j.matches[0]!.revealUnlocked).toBe(true);
    expect(j.matches[0]!.contact).toBe("tg:@bob_secret"); // A is allowed B's contact ONLY now
  });

  it("bad / expired / missing token → 401 (and never a match body)", async () => {
    // Missing token.
    expect((await get(`/api/matches`)).status).toBe(401);
    // Garbage token.
    const bad = await get(`/api/matches?token=not.a.valid.token`);
    expect(bad.status).toBe(401);
    expect((await bad.json() as { matches?: unknown }).matches).toBeUndefined();
    // Expired token (forged with a past exp; the minter won't emit one).
    const expired = await notifyMint(TEST_KEY, oA, Math.floor(Date.now() / 1000) - 10);
    const exp = await get(`/api/matches?token=${encodeURIComponent(expired)}`);
    expect(exp.status).toBe(401);
    expect((await exp.json() as { expired?: boolean }).expired).toBe(true);
  });

  it("an owner with no couples → empty matches", async () => {
    const token = await mintMatchToken(keyedEnv, oD === 0 ? 1 : oA); // use a real owner with a couple first…
    // …then assert via the helper for an owner that truly has none: make a lone owner.
    const db = makeDb(env.DB);
    const lonely = (await db.insert(owners).values({ contactRef: "contact@gokhan.vc" }).returning({ id: owners.id }).get()).id;
    const cards = await listMatchesForOwner(db, keyedEnv, lonely);
    expect(cards).toHaveLength(0);
    expect(token).toBeTruthy();
  });
});
