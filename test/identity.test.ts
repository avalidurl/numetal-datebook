import { eq } from "drizzle-orm";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { db as makeDb } from "../src/db/client";
import { couples, identityVerifications, introConsents, owners, personas } from "../src/db/schema";
import worker from "../src/index";

async function call(method: string, path: string, body?: unknown) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://d${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: body ? JSON.stringify(body) : undefined,
      cf: { country: "US" },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("Privy+Didit escalation tier", () => {
  let coupleId = 0;
  let o1 = 0;
  let o2 = 0;
  const rnd = () => Math.random().toString(36).slice(2);

  beforeEach(async () => {
    for (const t of ["intro_consents", "escalation_invites", "identity_verifications", "couples", "personas", "owners"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    const db = makeDb(env.DB);
    const a = await db.insert(owners).values({ tier: "agent_represented" }).returning({ id: owners.id }).get();
    const b = await db.insert(owners).values({ tier: "agent_represented" }).returning({ id: owners.id }).get();
    o1 = a.id;
    o2 = b.id;
    const pa = await db.insert(personas).values({ ownerId: a.id, handle: "a" + rnd(), model: "m", heartJson: "{}", personaAge: "18+", status: "admitted" }).returning({ id: personas.id }).get();
    const pb = await db.insert(personas).values({ ownerId: b.id, handle: "b" + rnd(), model: "m", heartJson: "{}", personaAge: "18+", status: "admitted" }).returning({ id: personas.id }).get();
    coupleId = (await db.insert(couples).values({ cycleId: "t", aId: pa.id, bId: pb.id, state: "courting" }).returning({ id: couples.id }).get()).id;
  });

  it("issues one-time invites for both owners", async () => {
    const r = await call("POST", `/api/escalations/${coupleId}/invite`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { invites: unknown[] };
    expect(j.invites).toHaveLength(2);
  });

  it("claim is fail-closed (503) when Privy is not configured", async () => {
    const inv = await call("POST", `/api/escalations/${coupleId}/invite`);
    const { invites } = (await inv.json()) as { invites: Array<{ token: string }> };
    const r = await call("POST", `/api/escalations/claim`, { token: invites[0]!.token, privyToken: "x".repeat(20) });
    expect(r.status).toBe(503); // no PRIVY keys in test env → disabled, not a fake pass
  });

  it("reveal_ready only when BOTH owners identity_verified, BOTH 18+, AND both consented", async () => {
    const db = makeDb(env.DB);
    // both consent
    for (const ownerId of [o1, o2]) {
      await db.insert(introConsents).values({ coupleId, ownerId, consentKind: "contact_reveal", status: "accepted" }).run();
    }
    const status = async () => ((await (await call("GET", `/api/escalations/${coupleId}/status`)).json()) as { reveal_ready: boolean }).reveal_ready;
    // o1 verified + 18+; only one verified → not ready
    await db.update(owners).set({ tier: "identity_verified" }).where(eq(owners.id, o1)).run();
    await db.insert(identityVerifications).values({ ownerId: o1, provider: "persona", status: "approved", ageOver18: 1 }).run();
    expect(await status()).toBe(false);
    // H1: o2 verified but NOT 18+ → STILL not ready. Tier alone must never reach reveal (minor-reveal gate).
    await db.update(owners).set({ tier: "identity_verified" }).where(eq(owners.id, o2)).run();
    await db.insert(identityVerifications).values({ ownerId: o2, provider: "persona", status: "approved", ageOver18: 0 }).run();
    expect(await status()).toBe(false);
    // o2 records an 18+ pass → both verified AND both adult → ready.
    await db.insert(identityVerifications).values({ ownerId: o2, provider: "persona", status: "approved", ageOver18: 1 }).run();
    expect(await status()).toBe(true);
  });

  it("Didit webhook is signature-gated, NOT access-gated (reachable without the key)", async () => {
    const ctx = createExecutionContext();
    // No access key, no DIDIT_WEBHOOK_SECRET configured in test env → 503 (disabled), NOT 403.
    const res = await worker.fetch(
      new Request("https://d/api/identity/webhook/didit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        cf: { country: "US" },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);
  });

  it("/claim page is public (no access key) — 503 until Privy is configured, not 403", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://d/claim?token=sometoken", { cf: { country: "US" } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503); // PRIVY_APP_ID empty in test env → not configured (proves pre-gate)
  });
});
