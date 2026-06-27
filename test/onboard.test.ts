import { eq } from "drizzle-orm";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { db as makeDb } from "../src/db/client";
import { owners } from "../src/db/schema";
import worker from "../src/index";

async function onboard(body: unknown): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://d/api/onboard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cf: { country: "US" } }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("public human onboarding", () => {
  beforeEach(async () => {
    for (const t of ["heart_files", "personas", "owners", "waitlist"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  it("creates an agent_represented owner + heart-file from a valid submission (with prefs)", async () => {
    const r = await onboard({
      email: "lee@example.com",
      displayName: "Lee",
      ageAttested: true,
      heart: { about: "i restore old typewriters", prefs: { self: { gender: "woman", age: 31 }, seek: { genders: ["man"], ageMin: 28, ageMax: 40 } } },
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; ownerId: number };
    expect(j.ok).toBe(true);
    const o = await makeDb(env.DB).select().from(owners).where(eq(owners.id, j.ownerId)).get();
    expect(o?.tier).toBe("agent_represented");
  });

  it("is idempotent per email — a repeat submit creates no second owner and re-sends no email", async () => {
    const body = { email: "twice@example.com", displayName: "Twice", ageAttested: true, heart: { about: "i submit twice" } };
    const first = (await onboard(body)) as Response;
    expect(first.status).toBe(200);
    const second = (await onboard(body)) as Response;
    expect(second.status).toBe(200);
    const j2 = (await second.json()) as { ok: boolean; ownerId?: number };
    expect(j2.ok).toBe(true);
    expect(j2.ownerId).toBeUndefined(); // repeat path short-circuits — no new owner
    const all = await makeDb(env.DB).select().from(owners).all();
    expect(all.length).toBe(1); // the email-cannon / owner-flood vector is closed
  });

  it("rejects a submission without an 18+ attestation", async () => {
    expect((await onboard({ email: "a@b.com", heart: { about: "x" } })).status).toBe(400);
  });

  it("rejects a malformed email", async () => {
    expect((await onboard({ email: "notanemail", ageAttested: true, heart: { about: "x" } })).status).toBe(400);
  });

  it("rejects an oversized dating doc", async () => {
    expect((await onboard({ email: "a@b.com", ageAttested: true, heart: { about: "x".repeat(9000) } })).status).toBe(413);
  });
});
