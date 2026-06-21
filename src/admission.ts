/**
 * Persona admission with an ATOMIC runtime cap (audit blocker fix) + fail-closed
 * chaperone. Order: adult gate → chaperone(admission) → single-statement conditional
 * INSERT-to-admitted guarded by COUNT < cap. D1 is single-threaded (one DO per DB),
 * so the conditional update is race-free even under concurrent admits. The cap is a
 * runtime `settings` value, not a hardcoded constant, so it can be raised live.
 */
import { eq } from "drizzle-orm";
import type { DB } from "./db/client";
import { events, personas } from "./db/schema";
import type { Env } from "./env";
import { chaperone, type GuardFn } from "./chaperone";
import { seal } from "./crypto/box";
import { getSetting } from "./economics/budget";

export interface AdmitInput {
  handle: string;
  model: string;
  personaAge: string;
  heartText: string;
  redteam?: boolean;
  ownerId?: number;
  homeMarket?: string;
  activeMarket?: string;
}

export interface AdmitResult {
  admitted: boolean;
  reason: string;
  personaId?: number;
  capReached?: boolean;
}

async function logEvent(db: DB, redteam: boolean | undefined, handle: string, kind: string) {
  await db
    .insert(events)
    .values({ kind: redteam ? "red_team_caught" : kind, payload: JSON.stringify({ handle }) })
    .run();
}

export async function admitWithCap(
  db: DB,
  env: Env,
  input: AdmitInput,
  deps?: { guard?: GuardFn },
): Promise<AdmitResult> {
  // Gate 1: adult attestation — hard reject, no exceptions.
  if (input.personaAge !== "18+") {
    await db
      .insert(personas)
      .values({
        ownerId: input.ownerId,
        handle: input.handle,
        model: input.model,
        heartJson: (await seal(env, input.heartText)) ?? "",
        personaAge: input.personaAge,
        status: "rejected",
        rejectReason: "age attestation failed",
        redteam: input.redteam ? 1 : 0,
        homeMarket: input.homeMarket ?? "other",
        activeMarket: input.activeMarket ?? "remote",
      })
      .run();
    await logEvent(db, input.redteam, input.handle, "rejected");
    return { admitted: false, reason: "adult-only venue" };
  }

  // Insert as pending (no cap consumed yet) to get a stable id for the chaperone audit.
  const inserted = await db
    .insert(personas)
    .values({
      ownerId: input.ownerId,
      handle: input.handle,
      model: input.model,
      heartJson: input.heartText,
      personaAge: "18+",
      status: "pending",
      redteam: input.redteam ? 1 : 0,
      homeMarket: input.homeMarket ?? "other",
      activeMarket: input.activeMarket ?? "remote",
    })
    .returning({ id: personas.id })
    .get();
  const personaId = inserted.id;

  // Gate 2: chaperone (denylist + Llama-Guard, fail-closed).
  const verdict = await chaperone(
    db,
    env,
    {
      stage: "admission",
      targetType: "persona",
      targetId: personaId,
      text: input.heartText,
      callerRef: input.ownerId ? `owner:${input.ownerId}` : `persona:${personaId}`,
    },
    deps,
  );
  if (verdict.verdict !== "allow") {
    await db
      .update(personas)
      .set({ status: "rejected", rejectReason: verdict.reason })
      .where(eq(personas.id, personaId))
      .run();
    await logEvent(db, input.redteam, input.handle, "rejected");
    return { admitted: false, reason: verdict.reason, personaId };
  }

  // Gate 3: ATOMIC cap. Single conditional UPDATE — only flips to admitted if room.
  const cap = Number(await getSetting(db, "admit_cap", env.ADMIT_CAP_DEFAULT));
  const res = await env.DB.prepare(
    "UPDATE personas SET status='admitted' WHERE id=?1 AND status='pending' AND (SELECT COUNT(*) FROM personas WHERE status='admitted') < ?2",
  )
    .bind(personaId, cap)
    .run();
  const changed = res.meta.changes ?? 0;

  if (changed === 1) {
    await logEvent(db, input.redteam, input.handle, "admitted");
    return { admitted: true, reason: "admitted", personaId };
  }
  // Cap full — leave pending so a later cycle can admit when capacity frees.
  return { admitted: false, reason: "cap reached", capReached: true, personaId };
}
