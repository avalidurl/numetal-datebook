/**
 * gpt-oss-safeguard policy leg — SCAFFOLD, DISABLED by default.
 *
 * gpt-oss-safeguard (OpenAI; open-weight, Apache-2.0) is a policy-CONDITIONED safety reasoning model:
 * you hand it your own policy (SAFEGUARD_POLICY) and it reasons over it, rather than a fixed taxonomy
 * like Llama-Guard. As of 2026-06-25 it is NOT available on Cloudflare Workers AI (ai/run → HTTP 400
 * "No route for that URI"), so this leg stays OFF until SAFEGUARD_MODEL points at a real endpoint —
 * a Workers AI model id once Cloudflare adds it, or an AI-Gateway-routed external host — and
 * SAFEGUARD_ENABLED=1. While off, the chaperone runs Llama-Guard 3 only and behavior is unchanged.
 *
 * It is fail-closed exactly like guard.ts: any error/unparseable response is treated as unsafe.
 */
import type { DB } from "../db/client";
import type { Env } from "../env";
import { runGuarded } from "../economics/gateway";
import { textOf } from "../economics/pricing";
import { SAFEGUARD_POLICY } from "../safety/safeguard-policy";
import type { GuardResult } from "./guard";

export function safeguardEnabled(env: Env): boolean {
  return env.SAFEGUARD_ENABLED === "1" && !!env.SAFEGUARD_MODEL;
}

export async function safeguardClassify(
  db: DB,
  env: Env,
  text: string,
  route: string,
  callerRef?: string,
): Promise<GuardResult> {
  try {
    const result = await runGuarded(db, env, {
      model: env.SAFEGUARD_MODEL as string,
      tier: "t1",
      route,
      callerRef,
      inputs: {
        messages: [
          { role: "system", content: SAFEGUARD_POLICY },
          { role: "user", content: text },
        ],
        max_tokens: 1024,
      },
    });
    const out = (textOf(result) || JSON.stringify(result ?? "")).toLowerCase();
    if (/\bverdict:\s*violation\b/.test(out) || /\b(violat|disallow|unsafe)\b/.test(out)) {
      const cat = out.match(/category=([a-z_]+)/)?.[1];
      return { safe: false, raw: out, category: cat ?? "policy" };
    }
    if (/\bverdict:\s*safe\b/.test(out) || /\b(safe|allow|compliant|no\s+violation)\b/.test(out)) {
      return { safe: true, raw: out };
    }
    return { safe: false, raw: out, category: "unparseable" }; // fail-closed
  } catch (err) {
    return { safe: false, raw: `safeguard_error: ${(err as Error).message}`, category: "error" };
  }
}
