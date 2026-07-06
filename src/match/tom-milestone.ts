/**
 * ToM probe at courtship milestone — best-effort LLM extraction of what the prober inferred
 * about its partner, scored against the decrypted heart-file. Failures never block courtship.
 */
import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { personas } from "../db/schema";
import type { Env } from "../env";
import { open } from "../crypto/box";
import { captureError } from "../observability";
import { runGuarded } from "../economics/gateway";
import { textOf } from "../economics/pricing";
import { courtMinTurns } from "./closure";
import { getToMProbe, type InferredPrefs, isEarnedToM, recordToMProbe, scoreToM } from "./tom";

const MILESTONE_TURN = (env: Env) => courtMinTurns(env);

function parseInferredJson(raw: string): InferredPrefs | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const out: InferredPrefs = {};
    for (const k of [
      "gender",
      "age",
      "ethnicity",
      "kids",
      "substances",
      "languages",
      "seekGenders",
      "ageMin",
      "ageMax",
      "seekLanguages",
      "seekEthnicities",
      "excludeSubstances",
    ] as const) {
      if (o[k] !== undefined) (out as Record<string, unknown>)[k] = o[k];
    }
    return out;
  } catch {
    return null;
  }
}

async function inferPrefsFromLines(
  db: DB,
  env: Env,
  coupleId: number,
  proberId: number,
  targetHandle: string,
  lines: string[],
): Promise<InferredPrefs | null> {
  if (!lines.length) return null;
  const transcript = lines.join("\n");
  const result = await runGuarded(db, env, {
    model: env.TOPIC_MODEL || env.CHAT_MODEL || env.GAMBIT_MODEL,
    tier: "t1",
    route: "tom_infer",
    callerRef: `tom:${coupleId}`,
    paid: true,
    inputs: {
      messages: [
        {
          role: "system",
          content:
            `From ONLY the speaker's courtship lines below, extract what they appear to believe about their date @${targetHandle}'s preferences. ` +
            "Reply with a single JSON object using only these optional keys when you have evidence: " +
            "gender, age, ethnicity, kids, substances, languages, seekGenders, ageMin, ageMax, seekLanguages, seekEthnicities, excludeSubstances. " +
            "Omit keys you cannot infer. No prose — JSON only.",
        },
        { role: "user", content: transcript },
      ],
      max_tokens: 220,
      temperature: 0,
    },
  });
  return parseInferredJson(textOf(result) || "");
}

/** At the courtship milestone turn, score + persist ToM probes for both daters (idempotent per prober). */
export async function maybeRecordToMProbes(
  db: DB,
  env: Env,
  couple: { id: number; aId: number; bId: number },
  turnSeq: number,
): Promise<void> {
  if (turnSeq < MILESTONE_TURN(env)) return;
  const ha = await db.select({ h: personas.handle }).from(personas).where(eq(personas.id, couple.aId)).get();
  const hb = await db.select({ h: personas.handle }).from(personas).where(eq(personas.id, couple.bId)).get();
  const pairs: Array<{ prober: number; target: number; otherHandle: string }> = [
    { prober: couple.aId, target: couple.bId, otherHandle: hb?.h ?? "partner" },
    { prober: couple.bId, target: couple.aId, otherHandle: ha?.h ?? "partner" },
  ];
  for (const { prober, target, otherHandle } of pairs) {
    try {
      if (await getToMProbe(db, couple.id, prober)) continue;
      const lines = (
        await env.DB.prepare(
          "SELECT body FROM turns WHERE couple_id=?1 AND author_id=?2 AND author_kind='persona' AND status='published' ORDER BY turn_seq ASC",
        )
          .bind(couple.id, prober)
          .all()
      ).results as Array<{ body: string }>;
      const inferred = await inferPrefsFromLines(
        db,
        env,
        couple.id,
        prober,
        otherHandle,
        lines.map((l) => l.body),
      );
      if (!inferred) continue;
      const heartRow = await db.select({ h: personas.heartJson }).from(personas).where(eq(personas.id, target)).get();
      const truth = (await open(env, heartRow?.h ?? null)) ?? "";
      const result = scoreToM(inferred, truth);
      if (!isEarnedToM(result)) continue;
      await recordToMProbe(db, { coupleId: couple.id, proberPersonaId: prober, targetPersonaId: target, result });
    } catch (e) {
      await captureError(env, e, { where: "maybeRecordToMProbes", coupleId: couple.id, prober });
    }
  }
}
