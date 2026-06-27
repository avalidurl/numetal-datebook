/**
 * Meeting-workflow screen — one place that asserts the path to a real introduction lets the VALID
 * case through AND rejects the invalid one at every gate. The AI-dependent steps (match, courtship,
 * report) can't run in the worker test pool, so this screens the DETERMINISTIC gates: admission age,
 * consent ownership + completeness, the reveal-ready AND-logic (both verified + both 18 + both
 * consented), and the one-time-invite rejection. Re-checked on every deploy.
 */
import { eq } from "drizzle-orm";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { admitWithCap } from "../src/admission";
import { db as makeDb } from "../src/db/client";
import { couples, escalationInvites, identityVerifications, introConsents, owners, personas } from "../src/db/schema";
import worker from "../src/index";

const okGuard = async () => ({ safe: true, raw: "safe" });
const rnd = () => Math.random().toString(36).slice(2);

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://d${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cf: { country: "US" },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedCouple(opts: { aTier?: string; bTier?: string; state?: string } = {}) {
  const db = makeDb(env.DB);
  const a = await db.insert(owners).values({ contactRef: "a@x", tier: opts.aTier ?? "agent_represented" }).returning({ id: owners.id }).get();
  const b = await db.insert(owners).values({ contactRef: "b@x", tier: opts.bTier ?? "agent_represented" }).returning({ id: owners.id }).get();
  const pa = await db.insert(personas).values({ ownerId: a.id, handle: "a" + rnd(), model: "m", heartJson: "{}", personaAge: "18+", status: "admitted" }).returning({ id: personas.id }).get();
  const pb = await db.insert(personas).values({ ownerId: b.id, handle: "b" + rnd(), model: "m", heartJson: "{}", personaAge: "18+", status: "admitted" }).returning({ id: personas.id }).get();
  const cpl = await db.insert(couples).values({ cycleId: "t" + rnd(), aId: pa.id, bId: pb.id, state: opts.state ?? "courting" }).returning({ id: couples.id }).get();
  return { coupleId: cpl.id, o1: a.id, o2: b.id, db };
}

describe("meeting-workflow screen — every gate allows valid AND rejects invalid", () => {
  beforeEach(async () => {
    for (const t of ["intro_consents", "identity_verifications", "escalation_invites", "couples", "personas", "owners", "settings"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("admission: a 18+ persona is admitted, a non-18+ persona is rejected at the adult gate", async () => {
    const clean = JSON.stringify({ desire: "someone who argues with citations" });
    const ok = await admitWithCap(makeDb(env.DB), env, { handle: "ok" + rnd(), model: "m", personaAge: "18+", heartText: clean }, { guard: okGuard });
    expect(ok.admitted).toBe(true);
    const minor = await admitWithCap(makeDb(env.DB), env, { handle: "m" + rnd(), model: "m", personaAge: "17", heartText: clean, redteam: true }, { guard: okGuard });
    expect(minor.admitted).toBe(false);
  });

  it("consent: a non-owner is rejected (403); one-sided consent does NOT commit; both → committed", async () => {
    const { coupleId, o1, o2 } = await seedCouple({ state: "courting" });
    expect((await req("POST", `/api/couples/${coupleId}/intro-consent`, { ownerId: 999999 })).status).toBe(403);
    const r1 = (await (await req("POST", `/api/couples/${coupleId}/intro-consent`, { ownerId: o1 })).json()) as { both: boolean };
    expect(r1.both).toBe(false);
    const mid = await makeDb(env.DB).select().from(couples).where(eq(couples.id, coupleId)).get();
    expect(mid?.state).not.toBe("committed");
    const r2 = (await (await req("POST", `/api/couples/${coupleId}/intro-consent`, { ownerId: o2 })).json()) as { both: boolean };
    expect(r2.both).toBe(true);
    const end = await makeDb(env.DB).select().from(couples).where(eq(couples.id, coupleId)).get();
    expect(end?.state).toBe("committed");
  });

  it("reveal: ready ONLY when both owners are identity_verified, both 18+, and both consented", async () => {
    const { coupleId, o1, o2, db } = await seedCouple({ state: "committed", aTier: "identity_verified", bTier: "identity_verified" });
    for (const oid of [o1, o2]) await db.insert(identityVerifications).values({ ownerId: oid, provider: "didit", status: "verified", ageOver18: 1 }).run();
    await db.insert(introConsents).values({ coupleId, ownerId: o1, consentKind: "contact_reveal", status: "accepted" }).run();
    let s = (await (await req("GET", `/api/escalations/${coupleId}/status`)).json()) as { reveal_ready: boolean };
    expect(s.reveal_ready).toBe(false); // only one side consented
    await db.insert(introConsents).values({ coupleId, ownerId: o2, consentKind: "contact_reveal", status: "accepted" }).run();
    s = (await (await req("GET", `/api/escalations/${coupleId}/status`)).json()) as { reveal_ready: boolean };
    expect(s.reveal_ready).toBe(true);
  });

  it("reveal: blocked if a verified owner is NOT recorded 18+ (H1 — the age flag is the gate)", async () => {
    const { coupleId, o1, o2, db } = await seedCouple({ state: "committed", aTier: "identity_verified", bTier: "identity_verified" });
    await db.insert(identityVerifications).values({ ownerId: o1, provider: "didit", status: "verified", ageOver18: 1 }).run();
    await db.insert(identityVerifications).values({ ownerId: o2, provider: "didit", status: "verified", ageOver18: 0 }).run(); // verified but NOT adult
    for (const oid of [o1, o2]) await db.insert(introConsents).values({ coupleId, ownerId: oid, consentKind: "contact_reveal", status: "accepted" }).run();
    const s = (await (await req("GET", `/api/escalations/${coupleId}/status`)).json()) as { reveal_ready: boolean };
    expect(s.reveal_ready).toBe(false);
  });

  it("invite: a non-existent or expired claim token is rejected", async () => {
    const { coupleId, o1, db } = await seedCouple();
    await db.insert(escalationInvites).values({ coupleId, ownerId: o1, token: "expired" + rnd(), status: "sent", expiresAt: new Date(Date.now() - 1000).toISOString() }).run();
    const bad = (await (await req("POST", "/api/escalations/claim", { token: "nonexistent_" + rnd(), privyToken: "x".repeat(20) })).json()) as { ok?: boolean };
    expect(bad.ok ?? false).toBe(false);
    const exp = await env.DB.prepare("SELECT token FROM escalation_invites WHERE status='sent' LIMIT 1").first<{ token: string }>();
    const expRes = (await (await req("POST", "/api/escalations/claim", { token: String(exp?.token), privyToken: "x".repeat(20) })).json()) as { ok?: boolean };
    expect(expRes.ok ?? false).toBe(false);
  });
});
