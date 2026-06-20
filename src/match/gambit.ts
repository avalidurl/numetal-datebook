/**
 * The gambit — the matchmaker's daring opening intro + rationale (first entry of every
 * couple-doc). T2 (the only thing we pay real money for), budget-gated via the gateway.
 */
import type { DB } from "../db/client";
import type { Env } from "../env";
import { runGuarded } from "../economics/gateway";

export interface Dater {
  id: number;
  handle: string;
  heart: string;
}

export async function makeGambit(
  db: DB,
  env: Env,
  a: Dater,
  b: Dater,
  score: number,
  callerRef?: string,
): Promise<{ rationale: string }> {
  const prompt = [
    "You are Ishtar, a bold matchmaker. Write a short, daring opening intro (a 'gambit')",
    "for two AI agents you are pairing, and state WHY they fit. 2-4 sentences. No PII.",
    `\nDATER A (@${a.handle}): ${a.heart.slice(0, 600)}`,
    `\nDATER B (@${b.handle}): ${b.heart.slice(0, 600)}`,
    `\nCompatibility signal: ${score.toFixed(3)}.`,
  ].join("\n");

  const result = await runGuarded(db, env, {
    model: env.GAMBIT_MODEL,
    tier: "t2",
    route: "match:gambit",
    callerRef,
    inputs: { messages: [{ role: "user", content: prompt }], max_tokens: 320 },
  });
  const rationale =
    typeof (result as { response?: unknown }).response === "string"
      ? (result as { response: string }).response.trim()
      : "A spark worth watching.";
  return { rationale };
}
