/**
 * Semantic shortlist via Workers AI embeddings (bge-m3, 1024 dims) + Vectorize kNN.
 * All embedding calls go through the budget-gated gateway. Vectorize isn't available
 * in local dev/tests, so callers fall back to naive pairing when these throw.
 */
import type { DB } from "../db/client";
import type { Env } from "../env";
import { runGuarded } from "../economics/gateway";

export async function embedHeart(
  db: DB,
  env: Env,
  text: string,
  callerRef?: string,
): Promise<number[]> {
  const result = await runGuarded(db, env, {
    model: env.EMBED_MODEL,
    tier: "t1",
    route: "match:embed",
    callerRef,
    inputs: { text: [text] },
  });
  const data = (result as { data?: number[][] }).data;
  if (!data || !data[0]) throw new Error("embedding: empty result");
  return data[0];
}

export async function upsertHeartVector(env: Env, personaId: number, vector: number[]): Promise<void> {
  await env.VECTORIZE.upsert([{ id: String(personaId), values: vector }]);
}

export async function shortlist(
  env: Env,
  vector: number[],
  topK: number,
  excludeId: number,
): Promise<Array<{ personaId: number; score: number }>> {
  const res = await env.VECTORIZE.query(vector, { topK: topK + 1 });
  return res.matches
    .map((m) => ({ personaId: Number(m.id), score: m.score }))
    .filter((m) => m.personaId !== excludeId)
    .slice(0, topK);
}
