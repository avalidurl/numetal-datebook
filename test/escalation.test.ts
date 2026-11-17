import { eq } from "drizzle-orm";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { db as makeDb } from "../src/db/client";
import { couples, owners, personas } from "../src/db/schema";
import worker from "../src/index";

async function post(path: string, body: unknown) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://d${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify(body),
      cf: { country: "US" },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("concierge escalation", () => {
  let coupleId = 0;
  let o1 = 0;
  let o2 = 0;
  const rnd = () => Math.random().toString(36).slice(2);

  beforeEach(async () => {
    for (const t of ["intro_consents", "couples", "personas", "owners"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    const db = makeDb(env.DB);
    const a = await db.insert(owners).values({ contactRef: "contact@gokhan.vc", tier: "agent_represented" }).returning({ id: owners.id }).get();
    const b = await db.insert(owners).values({ contactRef: "contact@gokhan.vc", tier: "agent_represented" }).returning({ id: owners.id }).get();
    o1 = a.id;
    o2 = b.id;
    const pa = await db.insert(personas).values({ ownerId: a.id, handle: "a" + rnd(), model: "m", heartJson: "{}", personaAge: "18+", status: "admitted" }).returning({ id: personas.id }).get();
    const pb = await db.insert(personas).values({ ownerId: b.id, handle: "b" + rnd(), model: "m", heartJson: "{}", personaAge: "18+", status: "admitted" }).returning({ id: personas.id }).get();
    const cpl = await db.insert(couples).values({ cycleId: "t", aId: pa.id, bId: pb.id, state: "courting" }).returning({ id: couples.id }).get();
    coupleId = cpl.id;
  });

  it("commits the couple only when BOTH owners consent", async () => {
    const r1 = await post(`/api/couples/${coupleId}/intro-consent`, { ownerId: o1 });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { both: boolean }).both).toBe(false);

    const r2 = await post(`/api/couples/${coupleId}/intro-consent`, { ownerId: o2 });
    expect(((await r2.json()) as { both: boolean }).both).toBe(true);

    const c = await makeDb(env.DB).select().from(couples).where(eq(couples.id, coupleId)).get();
    expect(c?.state).toBe("committed");
  });

  it("rejects an owner not in the couple", async () => {
    const r = await post(`/api/couples/${coupleId}/intro-consent`, { ownerId: 999999 });
    expect(r.status).toBe(403);
  });
});
