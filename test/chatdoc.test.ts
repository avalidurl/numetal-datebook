import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { submitDatingDoc } from "../src/routes/chat";
import { db as makeDb } from "../src/db/client";
import { attest18, mintSession } from "../src/economics/chatcredits";
import type { Env } from "../src/env";

// The chat→floor bridge. The HTTP route can't reach the live guard in the test runtime (AI binding
// dropped), so — like admission.test — we exercise the core function with an injected guard. MIN_DOC_USD
// is "0" in wrangler.test.toml so the paid floor is opt-in per test.
const okGuard = { guard: async () => ({ safe: true, raw: "safe" }) };
const unsafeGuard = { guard: async () => ({ safe: false, raw: "unsafe\nS1", category: "S1" }) };

const ADDR = "0x6666666666666666666666666666666666666666";
const HEART = { about: "warm, curious, lives by the tide charts", seeking: "someone kind and game", prefs: { self: { gender: "man" }, seek: { genders: ["woman"] } } };

describe("chat→floor bridge (submit-doc)", () => {
  beforeEach(async () => {
    for (const t of ["heart_files", "owner_wallets", "owners", "chat_sessions", "chat_accounts", "chaperone_decisions"])
      await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  it("HTTP 401 without a bearer session", async () => {
    const ctx = createExecutionContext();
    const r = await worker.fetch(
      new Request("https://d/api/chat/submit-doc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ heart: HEART }), cf: { country: "US" } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(r.status).toBe(401);
  });

  it("403 when the wallet has no recorded 18+ attestation", async () => {
    const r = await submitDatingDoc(makeDb(env.DB), env, { address: ADDR, heart: HEART }, okGuard);
    expect(r.code).toBe(403);
  });

  it("402 paid floor: blocks when the wallet holds < MIN_DOC_USD of $NUMETAL", async () => {
    const db = makeDb(env.DB);
    await attest18(db, ADDR);
    // MIN_DOC_USD=50 override; readNumetalUsd hits no funded wallet in test → usdHeld 0 → gated.
    const r = await submitDatingDoc(db, { MIN_DOC_USD: "50" } as unknown as Env, { address: ADDR, heart: HEART }, okGuard);
    expect(r.code).toBe(402);
    expect(r.body.required).toBe(50);
  });

  it("creates a HELD, wallet-bound dating doc on the happy path (gate disabled)", async () => {
    const db = makeDb(env.DB);
    await attest18(db, ADDR);
    const r = await submitDatingDoc(db, env, { address: ADDR, heart: HEART, email: "x@example.com" }, okGuard);
    expect(r.code).toBe(200);
    expect(r.body.status).toBe("pending_verification");
    const ownerId = r.body.ownerId as number;
    expect(ownerId).toBeGreaterThan(0);

    const w = await env.DB.prepare("SELECT count(*) c FROM owner_wallets WHERE address=?1").bind(ADDR).first<{ c: number }>();
    expect(w?.c).toBe(1); // bound to the wallet
    const o = await env.DB.prepare("SELECT status, tier, age_attested FROM owners WHERE id=?1").bind(ownerId).first<{ status: string; tier: string; age_attested: number }>();
    expect(o?.status).toBe("pending"); // HELD, not admitted to the floor
    expect(o?.tier).toBe("profile_claimed");
    expect(o?.age_attested).toBe(1);
    const hf = await env.DB.prepare("SELECT body_json FROM heart_files WHERE owner_id=?1").bind(ownerId).first<{ body_json: string }>();
    expect(hf?.body_json).toContain("tide charts");
  });

  it("a second submit from the same wallet adds a heart revision, not a duplicate owner", async () => {
    const db = makeDb(env.DB);
    await attest18(db, ADDR);
    await submitDatingDoc(db, env, { address: ADDR, heart: { about: "first cut of who I am here", seeking: "kindness" } }, okGuard);
    const r2 = await submitDatingDoc(db, env, { address: ADDR, heart: { about: "second cut, a little truer now", seeking: "warmth" } }, okGuard);
    expect(r2.body.revision).toBe(2);
    const owners = await env.DB.prepare("SELECT count(*) c FROM owners").first<{ c: number }>();
    expect(owners?.c).toBe(1); // one owner …
    const hfs = await env.DB.prepare("SELECT count(*) c FROM heart_files").first<{ c: number }>();
    expect(hfs?.c).toBe(2); // … two revisions
  });

  it("rejects a too-thin doc (400) and a chaperone-held doc (422)", async () => {
    const db = makeDb(env.DB);
    await attest18(db, ADDR);
    const thin = await submitDatingDoc(db, env, { address: ADDR, heart: { a: "1" } }, okGuard);
    expect(thin.code).toBe(400);
    const held = await submitDatingDoc(db, env, { address: ADDR, heart: HEART }, unsafeGuard);
    expect(held.code).toBe(422);
  });
});
