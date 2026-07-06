/**
 * Earned-commitment closure judge — shared by StreamCoordinator and POST /api/couples/:id/court.
 * One cheap classification call; budgeted under the stream's daily ceiling when callerRef=stream.
 */
import { db as makeDb, type DB } from "../db/client";
import type { Env } from "../env";
import { runGuarded } from "../economics/gateway";
import { textOf } from "../economics/pricing";

export type ClosureVerdict = "close" | "continue" | "fade";
export type CourtshipTerminal = "courting" | "committed" | "dormant";

/** Min turns before the closure judge runs (STREAM_S0_MIN_TURNS overrides STREAM_MIN_TURNS when set). */
export function courtMinTurns(env: Env): number {
  const s0 = env.STREAM_S0_MIN_TURNS;
  if (s0 != null && String(s0).trim() !== "") return Math.max(3, Number(s0) || 6);
  return Math.max(3, Number(env.STREAM_MIN_TURNS ?? "6") || 6);
}

export function courtMaxTurns(env: Env): number {
  return Math.max(4, Number(env.STREAM_MAX_TURNS ?? "16") || 16);
}

/** Aliases used by stream.ts + court.ts */
export const courtshipMinTurns = courtMinTurns;
export const courtshipMaxTurns = courtMaxTurns;

/** Map closure verdict + turn count to terminal couple state (no I/O). */
export function resolveCoupleState(
  env: Env,
  seq: number,
  verdict: ClosureVerdict | "continue",
): CourtshipTerminal {
  const min = courtMinTurns(env);
  const max = courtMaxTurns(env);
  if (seq < min) return "courting";
  if (verdict === "close") return "committed";
  if (verdict === "fade" || seq >= max) return "dormant";
  return "courting";
}

/** Judge whether a courtship reached a genuine mutual close (DB-injected — tests + resolveCourtshipState). */
export async function assessClosureWithDb(
  db: DB,
  env: Env,
  coupleId: number,
  callerRef = "stream",
): Promise<ClosureVerdict> {
  const rows = (
    await env.DB.prepare(
      "SELECT body FROM turns WHERE couple_id=?1 AND status='published' ORDER BY turn_seq ASC LIMIT 24",
    )
      .bind(coupleId)
      .all()
  ).results as Array<{ body: string }>;
  const transcript = rows.map((r) => r.body).join("\n");
  if (!transcript) return "continue";
  const result = await runGuarded(db, env, {
    model: env.CHAT_MODEL || env.GAMBIT_MODEL,
    tier: "t1",
    route: "closure",
    callerRef,
    paid: true,
    inputs: {
      messages: [
        {
          role: "system",
          content:
            "You judge a courtship transcript between two adults on Ishtar. Decide if it has reached a genuine mutual CLOSE (both have clearly, reciprocally signalled they want to meet or keep going — a natural landing), is still CONTINUE (warming, more to say), or has FADE (stalling, one-sided, or mutual disinterest). Reply with EXACTLY one word: CLOSE, CONTINUE, or FADE.",
        },
        { role: "user", content: `Transcript:\n${transcript}` },
      ],
      max_tokens: 6,
    },
  });
  const t = (textOf(result) || "").toUpperCase();
  if (t.includes("CLOSE")) return "close";
  if (t.includes("FADE")) return "fade";
  return "continue";
}

/** Worker-friendly assessClosure (opens DB internally) — signature expected by court.ts + stream.ts. */
export async function assessClosure(env: Env, coupleId: number, callerRef = "stream"): Promise<ClosureVerdict> {
  return assessClosureWithDb(makeDb(env.DB), env, coupleId, callerRef);
}

/** After a published turn, decide the couple's next state (earned commitment — never stamped). */
export async function resolveCourtshipState(
  db: DB,
  env: Env,
  coupleId: number,
  seq: number,
  opts?: { callerRef?: string; commitSource?: "stream" | "court_api" | "court" },
): Promise<{ state: CourtshipTerminal; commitSource?: string }> {
  const min = courtMinTurns(env);
  const max = courtMaxTurns(env);
  let state: CourtshipTerminal = "courting";
  let commitSource: string | undefined;
  if (seq >= min) {
    const verdict = await assessClosureWithDb(db, env, coupleId, opts?.callerRef ?? "stream").catch(() => "continue" as const);
    if (verdict === "close") {
      state = "committed";
      commitSource = opts?.commitSource ?? "stream";
    } else if (verdict === "fade" || seq >= max) {
      state = "dormant";
    }
  }
  return { state, commitSource };
}
