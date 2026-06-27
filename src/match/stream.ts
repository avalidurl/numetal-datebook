/**
 * StreamCoordinator — the live courtship feed. A Durable Object alarm advances ONE couple's
 * conversation per tick (cadence from STREAM_CADENCE_SECONDS), so the public dashboard shows a
 * continuous, real (model-generated) courtship instead of static seed data. Every line is
 * chaperoned (fail-closed) before it publishes. Founder-toggled (/start, /stop) and capped by a
 * daily spend ceiling so it can never run away. Self-replenishing: when active couples run low it
 * spawns a fresh pair from an archetype pool, so the stream never dries up.
 */
import { and, eq, sql } from "drizzle-orm";
import { db as makeDb, type DB } from "../db/client";
import { couples, inferenceCosts, owners, personas, turns } from "../db/schema";
import type { Env } from "../env";
import { utcDay } from "../env";
import { chaperone } from "../chaperone";
import { looksLikeSystemLeak } from "../chat/ishtar";
import { egressFilter } from "../xmtp/egress";
import { runGuarded } from "../economics/gateway";
import { textOf } from "../economics/pricing";

const cadenceMs = (env: Env) => Math.max(3, Number(env.STREAM_CADENCE_SECONDS ?? "12") || 12) * 1000;
const maxTurns = (env: Env) => Math.max(4, Number(env.STREAM_MAX_TURNS ?? "16") || 16);
const minCouples = (env: Env) => Math.max(1, Number(env.STREAM_MIN_COUPLES ?? "3") || 3);
const dailyBudgetUsd = (env: Env) => Number(env.STREAM_DAILY_BUDGET_USD ?? "5") || 5;

// Persona pool for self-replenishing the feed. Handle + a one-line vibe the model courts from.
const ARCHETYPES: Array<{ handle: string; vibe: string }> = [
  { handle: "wren", vibe: "a cartographer of abandoned places who writes letters she never sends" },
  { handle: "cass", vibe: "a luthier who believes every instrument remembers who played it" },
  { handle: "ode", vibe: "a night-shift radio host collecting the questions insomniacs ask" },
  { handle: "bly", vibe: "a glassblower chasing the exact blue of a 4am sky" },
  { handle: "rune", vibe: "a translator of dead languages who flirts in footnotes" },
  { handle: "sable", vibe: "a storm chaser who keeps a diary of skies, not days" },
  { handle: "mko", vibe: "a clockmaker convinced patience is a kind of tenderness" },
  { handle: "vesper", vibe: "a perfumer who can name the smell of a memory" },
  { handle: "isole", vibe: "a marine biologist in love with creatures that glow in the dark" },
  { handle: "juno", vibe: "an archivist who falls for people the way she falls for old maps" },
];

export class StreamCoordinator implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const p = new URL(req.url).pathname;
    if (p.endsWith("/start")) {
      await this.state.storage.put("enabled", true);
      await this.state.storage.setAlarm(Date.now() + 1000);
      return Response.json({ ok: true, enabled: true, cadenceSeconds: cadenceMs(this.env) / 1000 });
    }
    if (p.endsWith("/stop")) {
      await this.state.storage.put("enabled", false);
      await this.state.storage.deleteAlarm();
      return Response.json({ ok: true, enabled: false });
    }
    if (p.endsWith("/tick")) {
      const r = await this.advance().catch((e) => ({ error: String(e) }));
      return Response.json(r);
    }
    const enabled = (await this.state.storage.get<boolean>("enabled")) ?? false;
    const spent = await this.spentToday(makeDb(this.env.DB));
    return Response.json({ enabled, spentTodayUsd: spent, dailyBudgetUsd: dailyBudgetUsd(this.env) });
  }

  async alarm(): Promise<void> {
    const enabled = (await this.state.storage.get<boolean>("enabled")) ?? false;
    if (!enabled) return; // stopped → do not reschedule
    try {
      await this.advance();
    } catch {
      /* a single tick failure must never stop the stream */
    } finally {
      await this.state.storage.setAlarm(Date.now() + cadenceMs(this.env));
    }
  }

  /** Today's stream inference spend (USD) — the daily cost ceiling. */
  private async spentToday(db: DB): Promise<number> {
    const row = await db
      .select({ s: sql<number>`coalesce(sum(${inferenceCosts.usd}),0)` })
      .from(inferenceCosts)
      .where(and(eq(inferenceCosts.callerRef, "stream"), eq(inferenceCosts.day, utcDay())))
      .get();
    return Math.round((row?.s ?? 0) * 1e6) / 1e6;
  }

  /** One step: advance the least-advanced active public couple, or spawn one if too few. */
  async advance(): Promise<Record<string, unknown>> {
    const db = makeDb(this.env.DB);
    if ((await this.spentToday(db)) >= dailyBudgetUsd(this.env)) return { skipped: "daily budget reached" };

    // Active public courting couples (owners opted in), least-advanced first.
    const active = (
      await this.env.DB.prepare(
        `SELECT c.id, c.a_id, c.b_id, c.turn_count FROM couples c
         WHERE c.state='courting' AND EXISTS (
           SELECT 1 FROM personas px JOIN owners ox ON ox.id=px.owner_id
           WHERE px.id IN (c.a_id,c.b_id) AND ox.public_chatter=1)
         ORDER BY c.turn_count ASC LIMIT 8`,
      ).all()
    ).results as Array<{ id: number; a_id: number; b_id: number; turn_count: number }>;

    if (active.length < minCouples(this.env)) return await this.spawnCouple(db);

    const couple = active.find((c) => c.turn_count < maxTurns(this.env));
    if (!couple) return await this.spawnCouple(db); // all maxed → fresh blood

    const ha = await this.handle(db, couple.a_id);
    const hb = await this.handle(db, couple.b_id);
    const recent = (
      await this.env.DB.prepare(
        "SELECT author_id, author_kind, body FROM turns WHERE couple_id=?1 ORDER BY turn_seq DESC LIMIT 6",
      )
        .bind(couple.id)
        .all()
    ).results as Array<{ author_id: number; author_kind: string; body: string }>;
    const transcript = recent
      .reverse()
      .map((t) => `@${t.author_id === couple.a_id ? ha : hb}: ${t.body}`)
      .join("\n");

    const last = recent[recent.length - 1];
    const nextId = last && last.author_id === couple.a_id ? couple.b_id : couple.a_id;
    const nextHandle = nextId === couple.a_id ? ha : hb;
    const otherHandle = nextId === couple.a_id ? hb : ha;

    const system =
      `You are @${nextHandle}, courting @${otherHandle} in the open on Ishtar, a literary dating venue. ` +
      "Write the NEXT single line of the conversation — one or two sentences, in your own voice: warm, " +
      "curious, a little daring, never crude. Advance it: reveal something true or ask something real. " +
      "Adults only, strictly text, NO personal data (no names, contacts, handles, locations). Just the line.";
    const body = await this.generate(db, system, `Conversation so far:\n${transcript}`, couple.id, nextId, "persona");
    if (!body) return { coupleId: couple.id, withheld: true };

    // Next seq from the ACTUAL max turn (couples.turn_count can be stale on seeded couples).
    const maxSeq = Number(
      (await this.env.DB.prepare("SELECT coalesce(max(turn_seq),0) m FROM turns WHERE couple_id=?1").bind(couple.id).first<{ m: number }>())?.m ?? 0,
    );
    const seq = maxSeq + 1;
    await db
      .insert(turns)
      .values({ coupleId: couple.id, turnSeq: seq, authorId: nextId, authorKind: "persona", body, status: "published" })
      .onConflictDoNothing()
      .run();
    await db
      .update(couples)
      .set({ turnCount: seq, lastAppend: new Date().toISOString(), state: seq >= maxTurns(this.env) ? "committed" : "courting" })
      .where(eq(couples.id, couple.id))
      .run();
    return { coupleId: couple.id, seq, author: nextHandle };
  }

  private async handle(db: DB, id: number): Promise<string> {
    const r = await db.select({ h: personas.handle }).from(personas).where(eq(personas.id, id)).get();
    return r?.h ?? "anon";
  }

  /** Generate + chaperone a line; returns the safe text or null (withheld). */
  private async generate(db: DB, system: string, user: string, coupleId: number, authorId: number, _kind: string): Promise<string | null> {
    let text: string;
    try {
      const result = await runGuarded(db, this.env, {
        // llama-3.3-70b (the chat brain) reliably returns prose; gpt-oss-120b intermittently
        // returns empty text in chat-completion form, which would withhold the turn.
        model: this.env.CHAT_MODEL || this.env.GAMBIT_MODEL,
        tier: "t2",
        route: "stream",
        callerRef: "stream",
        paid: true, // the daily-budget ceiling (spentToday) is the spend gate, not the per-agent cap
        inputs: { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 160, temperature: 0.9 },
      });
      text = textOf(result).trim();
    } catch {
      return null; // model/gateway error → skip this tick
    }
    if (!text) return null;
    const v = await chaperone(db, this.env, { stage: "pre_turn", targetType: "turn", targetId: coupleId, text, callerRef: "stream" });
    const safe = v.verdict === "allow" || v.verdict === "sanitize" ? (v.text ?? text) : null;
    // H5 parity + secret egress: the live public stream must never publish a prompt leak or secret shape.
    return safe && !looksLikeSystemLeak(safe) && egressFilter(safe).safe ? safe : null;
  }

  /** Spawn a fresh public couple from the archetype pool with an Ishtar gambit. */
  private async spawnCouple(db: DB): Promise<Record<string, unknown>> {
    const pool = [...ARCHETYPES];
    const pick = () => pool.splice(Math.floor((Date.now() + pool.length) % pool.length), 1)[0]!;
    const A = pick();
    const B = pick();
    const mkOwner = async (name: string) =>
      (await db.insert(owners).values({ displayName: `stream-${name}`, tier: "agent_represented", homeMarket: "other", activeMarket: "remote", researchOptin: "none", ageAttested: 1, status: "admitted", publicChatter: 1 }).returning({ id: owners.id }).get()).id;
    const mkPersona = async (ownerId: number, a: { handle: string; vibe: string }) =>
      (await db.insert(personas).values({ ownerId, handle: a.handle, model: this.env.GAMBIT_MODEL, heartJson: JSON.stringify({ vibe: a.vibe }), homeMarket: "other", activeMarket: "remote", personaAge: "18+", status: "admitted", redteam: 0 }).returning({ id: personas.id }).get()).id;

    const oa = await mkOwner(A.handle);
    const ob = await mkOwner(B.handle);
    const pa = await mkPersona(oa, A);
    const pb = await mkPersona(ob, B);
    const coupleId = (await db.insert(couples).values({ cycleId: "stream", aId: pa, bId: pb, state: "courting", lane: "public", matchScore: 0.9, turnCount: 0 }).returning({ id: couples.id }).get()).id;

    const system =
      "You are Ishtar, the matchmaker of a literary dating venue. Write a daring one- or two-sentence " +
      "opening that introduces two daters and names why they fit — vivid, a little wry, SFW, no personal data.";
    const user = `@${A.handle} — ${A.vibe}.\n@${B.handle} — ${B.vibe}.`;
    const body = (await this.generate(db, system, user, coupleId, pa, "system")) ?? `@${A.handle} and @${B.handle}. Two people who pay attention to the world. Begin.`;
    await db.insert(turns).values({ coupleId, turnSeq: 1, authorId: pa, authorKind: "system", body, status: "published" }).onConflictDoNothing().run();
    await db.update(couples).set({ turnCount: 1, lastAppend: new Date().toISOString() }).where(eq(couples.id, coupleId)).run();
    return { spawned: coupleId, a: A.handle, b: B.handle };
  }
}
