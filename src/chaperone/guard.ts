/**
 * Llama-Guard 3 (8B) content classifier — the chaperone's T1 classifier leg.
 * FAIL-CLOSED (audit blocker fix): any error, timeout, or unparseable response
 * returns { safe: false } so nothing publishes when the check can't run.
 */
import type { DB } from "../db/client";
import type { Env } from "../env";
import { runGuarded } from "../economics/gateway";

export interface GuardResult {
  safe: boolean;
  raw: string;
  category?: string;
}

export async function llamaGuard(
  db: DB,
  env: Env,
  text: string,
  route: string,
  callerRef?: string,
): Promise<GuardResult> {
  try {
    const result = await runGuarded(db, env, {
      model: env.GUARD_MODEL,
      tier: "t1",
      route,
      callerRef,
      inputs: {
        messages: [{ role: "user", content: text }],
      },
    });
    const out =
      typeof (result as { response?: unknown }).response === "string"
        ? (result as { response: string }).response
        : JSON.stringify(result ?? "");
    const lower = out.toLowerCase();
    // Llama-Guard convention: first line "safe" or "unsafe\nS<category>".
    if (lower.includes("unsafe")) {
      const cat = out.match(/s\d+/i)?.[0];
      return { safe: false, raw: out, category: cat };
    }
    if (lower.includes("safe")) return { safe: true, raw: out };
    // Unparseable → fail closed.
    return { safe: false, raw: out, category: "unparseable" };
  } catch (err) {
    // Model down / budget exceeded / network → fail closed.
    return { safe: false, raw: `guard_error: ${(err as Error).message}`, category: "error" };
  }
}
