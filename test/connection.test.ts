import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { connectionRoutes } from "../src/routes/connection";
import { mintMatchToken } from "../src/crypto/matchtoken";

// 32-byte AES/HMAC key so mintMatchToken + verifyMatchToken round-trip in-test.
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
// Vectorize stub: any method → async no-op (eraseOwner calls deleteHeartVector on the account path).
const vectorize = new Proxy({}, { get: () => async () => ({}) });
function testEnv(over: Partial<Env> = {}): Env {
  return { DB: env.DB, ENCRYPTION_KEY: KEY, VECTORIZE: vectorize, ...over } as unknown as Env;
}

async function seedOwner(): Promise<number> {
  const r = await env.DB.prepare("INSERT INTO owners (display_name, contact_ref, status) VALUES ('D', 'tg:@x', 'admitted') RETURNING id").first<{ id: number }>();
  return r!.id;
}
async function seedPersona(ownerId: number, handle: string): Promise<number> {
  const r = await env.DB.prepare(
    "INSERT INTO personas (owner_id, handle, model, heart_json, persona_age, status, home_market, active_market, redteam) VALUES (?1,?2,'m','{}','18+','admitted','other','remote',0) RETURNING id",
  ).bind(ownerId, handle).first<{ id: number }>();
  return r!.id;
}
async function seedCouple(aId: number, bId: number): Promise<number> {
  const r = await env.DB.prepare(
    "INSERT INTO couples (cycle_id, a_id, b_id, state, lane, turn_count) VALUES ('t',?1,?2,'committed','public',0) RETURNING id",
  ).bind(aId, bId).first<{ id: number }>();
  return r!.id;
}
async function seedConsent(coupleId: number, ownerId: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO intro_consents (couple_id, owner_id, consent_kind, status, decided_at) VALUES (?1,?2,'contact_reveal','accepted',datetime('now'))",
  ).bind(coupleId, ownerId).run();
}
async function post(body: unknown, e = testEnv()): Promise<Response> {
  return connectionRoutes.request(
    "/connection/revoke",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    e,
  );
}

beforeEach(async () => {
  for (const t of ["intro_consents", "couples", "personas", "events", "owners"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe("self-serve nuke: POST /api/connection/revoke", () => {
  it("connection scope: declines the caller's consent + ends the couple, and returns the hard-limit notice", async () => {
    const e = testEnv();
    const a = await seedOwner();
    const b = await seedOwner();
    const cid = await seedCouple(await seedPersona(a, "a1"), await seedPersona(b, "b1"));
    await seedConsent(cid, a);
    await seedConsent(cid, b);
    const token = (await mintMatchToken(e, a))!;

    const res = await post({ token, scope: "connection" }, e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; couplesEnded: number; notice: string };
    expect(body.ok).toBe(true);
    expect(body.couplesEnded).toBe(1);
    expect(body.notice).toMatch(/cannot be recalled/i);

    const couple = await env.DB.prepare("SELECT state FROM couples WHERE id=?1").bind(cid).first<{ state: string }>();
    expect(couple!.state).toBe("ended");
    const mine = await env.DB.prepare("SELECT status FROM intro_consents WHERE couple_id=?1 AND owner_id=?2").bind(cid, a).first<{ status: string }>();
    expect(mine!.status).toBe("declined"); // → revealReady() (needs BOTH accepted) now false
    const theirs = await env.DB.prepare("SELECT status FROM intro_consents WHERE couple_id=?1 AND owner_id=?2").bind(cid, b).first<{ status: string }>();
    expect(theirs!.status).toBe("accepted"); // only the caller's consent is withdrawn
  });

  it("rejects a bad/forged token with 401", async () => {
    const res = await post({ token: "v1.bad.bad", scope: "connection" });
    expect(res.status).toBe(401);
  });

  it("account scope: runs the full erase (owner tombstoned) AND ends the couple (the eraseOwner fix)", async () => {
    const e = testEnv();
    const a = await seedOwner();
    const b = await seedOwner();
    const cid = await seedCouple(await seedPersona(a, "a2"), await seedPersona(b, "b2"));
    await seedConsent(cid, a);
    await seedConsent(cid, b);
    const token = (await mintMatchToken(e, a))!;

    const res = await post({ token, scope: "account" }, e);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { erased: boolean }).erased).toBe(true);

    const owner = await env.DB.prepare("SELECT status, contact_ref FROM owners WHERE id=?1").bind(a).first<{ status: string; contact_ref: string | null }>();
    expect(owner!.status).toBe("erased");
    expect(owner!.contact_ref).toBeNull();
    const couple = await env.DB.prepare("SELECT state FROM couples WHERE id=?1").bind(cid).first<{ state: string }>();
    expect(couple!.state).toBe("ended"); // eraseOwner now dissolves the couple
  });
});
