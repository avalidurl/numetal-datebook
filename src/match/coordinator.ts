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
import { looksLikeSystemLeak } from "../chat/ishtar";
import { open } from "../crypto/box";
import { getSetting } from "../economics/budget";
import { captureError } from "../observability";
import { compatible, coldScore, type EligPersona, parseHeart } from "./eligibility";
import { greedyPair, pairKey, type Candidate } from "./pairing";
import { embedHeart, shortlist, upsertHeartVector } from "./shortlist";
import { makeGambit } from "./gambit";

const intervalMs = (env: Env): number => (env.SIM_MODE === "day0" ? 5 * 60_000 : 60 * 60_000);

type Persona = { id: number; handle: string; heart: string; activeMarket: string; homeMarket: string };
type View = EligPersona & { heartText: string };

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
      .select({
        id: personas.id,
        handle: personas.handle,
        heart: personas.heartJson,
        activeMarket: personas.activeMarket,
        homeMarket: personas.homeMarket,
      })
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

    const allPairs = greedyPair(await this.buildEdges(db, free));
    // Bound the beat: cap couples (and therefore gambits — the only paid call) per beat so a
    // sudden flood of admits can't spike spend (committee economics finding).
    const maxPairs = Number(await getSetting(db, "beat_max_pairs", this.env.BEAT_MAX_PAIRS)) || 50;
    const pairs = allPairs.slice(0, maxPairs);

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
      // A single couple's gambit failure must not abort the beat or leave it stuck in 'met'.
      try {
        await this.seedGambit(db, ins.id, p, free);
      } catch (e) {
        await captureError(this.env, e, { where: "seedGambit", coupleId: ins.id });
        await db
          .update(couples)
          .set({ state: "courting", lastAppend: new Date().toISOString() })
          .where(eq(couples.id, ins.id))
          .run()
          .catch(() => {});
      }
    }

    await db
      .insert(events)
      .values({ kind: "matched", payload: JSON.stringify({ cycleId, created }) })
      .run();
    await this.state.storage.put("last_cycle", cycleId);
    return { cycleId, pairs: pairs.length, created };
  }

  /** Decrypt each heart once and build the eligibility view used by both edge strategies. */
  private async buildView(eligible: Persona[]): Promise<Map<number, View>> {
    const view = new Map<number, View>();
    for (const p of eligible) {
      const heartText = (await open(this.env, p.heart)) ?? "";
      view.set(p.id, {
        id: p.id,
        activeMarket: p.activeMarket,
        homeMarket: p.homeMarket,
        parsed: parseHeart(heartText),
        heartText,
      });
    }
    return view;
  }

  private async buildEdges(db: DB, eligible: Persona[]): Promise<Candidate[]> {
    const view = await this.buildView(eligible);
    // Preferred: embeddings + Vectorize kNN, made RECIPROCAL (a near b AND b near a) and
    // eligibility-filtered. Fallback: a real cold-start matcher (NOT insertion order).
    try {
      const directed = new Map<string, number>(); // "from->to" → score
      for (const p of eligible) {
        const v = view.get(p.id)!;
        const vec = await embedHeart(db, this.env, v.heartText, `persona:${p.id}`);
        await upsertHeartVector(this.env, p.id, vec);
        for (const n of await shortlist(this.env, vec, 12, p.id)) {
          if (!view.has(n.personaId)) continue; // ineligible (coupled/removed) neighbor
          directed.set(`${p.id}->${n.personaId}`, n.score);
        }
      }
      const edges = this.reciprocalEdges(directed, view);
      if (edges.length) return edges;
    } catch (e) {
      await captureError(this.env, e, { where: "buildEdges:embeddings" });
    }
    return this.coldStartEdges([...view.keys()], view);
  }

  /** One-way nearest ≠ mutual fit (committee finding): keep an edge only if it survives the
   *  eligibility gate; score mutual pairs by the average of both directions and penalize
   *  one-way-only edges so reciprocated matches always sort first. */
  private reciprocalEdges(directed: Map<string, number>, view: Map<number, View>): Candidate[] {
    const pairs = new Map<string, { a: number; b: number; sab?: number; sba?: number }>();
    for (const [k, score] of directed) {
      const [from, to] = k.split("->").map(Number) as [number, number];
      const key = pairKey(from, to);
      const cur = pairs.get(key) ?? { a: Math.min(from, to), b: Math.max(from, to) };
      if (from === cur.a) cur.sab = score;
      else cur.sba = score;
      pairs.set(key, cur);
    }
    const out: Candidate[] = [];
    for (const { a, b, sab, sba } of pairs.values()) {
      const va = view.get(a);
      const vb = view.get(b);
      if (!va || !vb || !compatible(va, vb).ok) continue;
      const score = sab != null && sba != null ? (sab + sba) / 2 : (sab ?? sba ?? 0) * 0.5;
      out.push({ aId: a, bId: b, score });
    }
    return out;
  }

  private coldStartEdges(ids: number[], view: Map<number, View>): Candidate[] {
    const out: Candidate[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const va = view.get(ids[i]!)!;
        const vb = view.get(ids[j]!)!;
        if (!compatible(va, vb).ok) continue;
        out.push({ aId: Math.min(ids[i]!, ids[j]!), bId: Math.max(ids[i]!, ids[j]!), score: coldScore(va, vb) });
      }
    }
    return out;
  }

  private async seedGambit(db: DB, coupleId: number, p: Candidate, eligible: Persona[]): Promise<void> {
    const a = eligible.find((x) => x.id === p.aId);
    const b = eligible.find((x) => x.id === p.bId);
    if (!a || !b) return;
    const aHeart = (await open(this.env, a.heart)) ?? "";
    const bHeart = (await open(this.env, b.heart)) ?? "";

    let rationale = "A spark worth watching.";
    try {
      rationale = (
        await makeGambit(
          db,
          this.env,
          { id: a.id, handle: a.handle, heart: aHeart },
          { id: b.id, handle: b.handle, heart: bHeart },
          p.score,
          "system",
        )
      ).rationale;
    } catch (e) {
      await captureError(this.env, e, { where: "seedGambit:makeGambit", coupleId });
      /* BudgetExceeded / model error → keep placeholder; the couple still forms */
    }

    // Fail-CLOSED: a chaperone error holds the turn (never publishes unreviewed output).
    // allow|sanitize → publish (sanitize publishes the REDACTED text); deny → blocked.
    let status: "published" | "held" | "blocked" = "held";
    let reason = "held: chaperone unavailable";
    let body = rationale;
    try {
      const verdict = await chaperone(db, this.env, {
        stage: "pre_turn",
        targetType: "turn",
        targetId: coupleId,
        text: rationale,
        callerRef: "system",
      });
      if (verdict.verdict === "allow" || verdict.verdict === "sanitize") {
        status = "published";
        body = verdict.text ?? rationale;
      } else if (verdict.verdict === "deny") {
        status = "blocked";
      } else {
        status = "held";
      }
      reason = verdict.reason;
    } catch (e) {
      await captureError(this.env, e, { where: "seedGambit:chaperone", coupleId });
      /* keep held */
    }
    // H5 parity: a published gambit must not leak the system prompt either.
    if (status === "published" && looksLikeSystemLeak(body)) {
      status = "blocked";
      reason = "blocked: instruction disclosure";
    }
    await db
      .insert(turns)
      .values({ coupleId, turnSeq: 1, authorId: p.aId, authorKind: "system", body, status, moderation: reason })
      .onConflictDoNothing()
      .run()
      .catch(() => {});
    // Only advance to 'courting' when the gambit is actually PUBLISHED (allow/sanitize). A blocked
    // (deny) or held (chaperone unavailable/error) gambit must NOT carry the couple forward with
    // unreviewed content — it stays in 'met' for review/retry on a later beat (red-team H4: the old
    // unconditional advance let a fail-closed verdict still progress, and an operator approving the
    // held turn would publish unguarded content).
    if (status === "published") {
      await db
        .update(couples)
        .set({ rationale: body, turnCount: 1, lastAppend: new Date().toISOString(), state: "courting" })
        .where(eq(couples.id, coupleId))
        .run();
    }
  }
}
