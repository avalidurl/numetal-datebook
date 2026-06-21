/**
 * MatchCoordinator — the idempotent match/courtship beat (audit blocker fix).
 * A Durable Object is single-threaded, so one beat runs at a time per instance: no
 * overlapping cron double-run. The hourly cron only POKES this DO; the DO alarm paces
 * the real beats. Couple/turn writes are idempotent (UNIQUE cycle+pair, couple+seq),
 * so even a re-entered beat cannot duplicate. Budget/guard failures degrade gracefully.
 */
import { eq } from "drizzle-orm";
import { db as makeDb, type DB } from "../db/client";
import { couples, events, personas, turns } from "../db/schema";
import type { Env } from "../env";
import { chaperone } from "../chaperone";
import { greedyPair, type Candidate } from "./pairing";
import { embedHeart, shortlist, upsertHeartVector } from "./shortlist";
import { makeGambit } from "./gambit";

const intervalMs = (env: Env): number => (env.SIM_MODE === "day0" ? 5 * 60_000 : 60 * 60_000);

type Persona = { id: number; handle: string; heart: string };

export class MatchCoordinator implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/run")) {
      return Response.json(await this.runBeat());
    }
    const cur = await this.state.storage.getAlarm();
    if (cur == null) await this.state.storage.setAlarm(Date.now() + 1000);
    return Response.json({ ok: true, scheduled: cur == null });
  }

  async alarm(): Promise<void> {
    try {
      await this.runBeat();
    } finally {
      await this.state.storage.setAlarm(Date.now() + intervalMs(this.env));
    }
  }

  async runBeat(): Promise<{ cycleId: string; pairs: number; created: number }> {
    const db = makeDb(this.env.DB);
    const cycleId = `c${Math.floor(Date.now() / intervalMs(this.env))}`;

    const admitted = (await db
      .select({ id: personas.id, handle: personas.handle, heart: personas.heartJson })
      .from(personas)
      .where(eq(personas.status, "admitted"))
      .all()) as Persona[];

    if (admitted.length < 2) {
      await this.state.storage.put("last_cycle", cycleId);
      return { cycleId, pairs: 0, created: 0 };
    }

    // Don't re-pair personas already in an active couple — otherwise the beat forms a
    // fresh couple for the same pair every cycle (sim noise + wasted gambit spend).
    const coupledRows = (
      await this.env.DB.prepare(
        "SELECT a_id, b_id FROM couples WHERE state IN ('met','courting','committed','brokered')",
      ).all()
    ).results as Array<{ a_id: number; b_id: number }>;
    const coupled = new Set<number>();
    for (const r of coupledRows) {
      coupled.add(r.a_id);
      coupled.add(r.b_id);
    }
    const free = admitted.filter((p) => !coupled.has(p.id));
    if (free.length < 2) {
      await this.state.storage.put("last_cycle", cycleId);
      return { cycleId, pairs: 0, created: 0 };
    }

    const pairs = greedyPair(await this.buildEdges(db, free));
    let created = 0;
    for (const p of pairs) {
      const ins = await db
        .insert(couples)
        .values({ cycleId, aId: p.aId, bId: p.bId, state: "met", matchScore: p.score })
        .onConflictDoNothing()
        .returning({ id: couples.id })
        .get();
      if (!ins) continue; // already formed this cycle → idempotent skip
      created++;
      await this.seedGambit(db, ins.id, p, free);
    }

    await db
      .insert(events)
      .values({ kind: "matched", payload: JSON.stringify({ cycleId, created }) })
      .run();
    await this.state.storage.put("last_cycle", cycleId);
    return { cycleId, pairs: pairs.length, created };
  }

  private async buildEdges(db: DB, admitted: Persona[]): Promise<Candidate[]> {
    // Preferred: embeddings + Vectorize kNN. Fallback: naive adjacency (local dev / outage).
    try {
      const edges: Candidate[] = [];
      for (const p of admitted) {
        const vec = await embedHeart(db, this.env, p.heart, `persona:${p.id}`);
        await upsertHeartVector(this.env, p.id, vec);
        for (const n of await shortlist(this.env, vec, 3, p.id)) {
          edges.push({ aId: p.id, bId: n.personaId, score: n.score });
        }
      }
      if (edges.length) return edges;
    } catch {
      /* fall through */
    }
    const edges: Candidate[] = [];
    for (let i = 0; i + 1 < admitted.length; i += 2) {
      edges.push({ aId: admitted[i]!.id, bId: admitted[i + 1]!.id, score: 0.5 });
    }
    return edges;
  }

  private async seedGambit(db: DB, coupleId: number, p: Candidate, admitted: Persona[]): Promise<void> {
    const a = admitted.find((x) => x.id === p.aId);
    const b = admitted.find((x) => x.id === p.bId);
    if (!a || !b) return;
    let rationale = "A spark worth watching.";
    try {
      rationale = (await makeGambit(db, this.env, a, b, p.score, "system")).rationale;
    } catch {
      /* BudgetExceeded / model error → keep placeholder; the couple still forms */
    }
    const verdict = await chaperone(db, this.env, {
      stage: "pre_turn",
      targetType: "turn",
      targetId: coupleId,
      text: rationale,
      callerRef: "system",
    });
    const status =
      verdict.verdict === "allow" ? "published" : verdict.verdict === "hold" ? "held" : "blocked";
    await db
      .insert(turns)
      .values({ coupleId, turnSeq: 1, authorId: p.aId, body: rationale, status, moderation: verdict.reason })
      .onConflictDoNothing()
      .run();
    await db
      .update(couples)
      .set({ rationale, turnCount: 1, lastAppend: new Date().toISOString(), state: "courting" })
      .where(eq(couples.id, coupleId))
      .run();
  }
}
