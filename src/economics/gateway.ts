/**
 * The ONE chokepoint for every model call (audit high-fix). Routes through Cloudflare
 * AI Gateway (dollar spend cap set in dashboard), enforces our own per-day budget,
 * and writes the inference_costs ledger so the loop-closure metric is computable.
 * Nothing in the codebase should call env.AI.run directly — always go through here.
 */
import type { DB } from "../db/client";
import { inferenceCosts } from "../db/schema";
import type { Env } from "../env";
import { utcDay } from "../env";
import { assertWithinBudget } from "./budget";
import { costUsd, tokensOf } from "./pricing";

export type Tier = "t0" | "t1" | "t2";

export interface RunOpts {
  model: string;
  tier: Tier;
  route: string;
  callerRef?: string;
  /** Paid artifact (x402-settled): track cost but skip the free-tier budget cap. */
  paid?: boolean;
  inputs: Record<string, unknown>;
}

type AiRun = (model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;

function promptTextOf(inputs: Record<string, unknown>): string {
  if (typeof inputs.prompt === "string") return inputs.prompt;
  if (typeof inputs.text === "string") return inputs.text;
  if (Array.isArray(inputs.messages)) {
    return (inputs.messages as Array<{ content?: unknown }>)
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
  }
  return JSON.stringify(inputs);
}

/**
 * Budget-gated, gateway-routed, ledger-logged model call.
 * Throws BudgetExceeded (from budget.ts) when a t2 call would cross a cap — callers
 * catch it and degrade to a 402 or a cached/cheaper answer (fail-closed on spend).
 */
export async function runGuarded(db: DB, env: Env, opts: RunOpts): Promise<unknown> {
  if (!opts.paid) await assertWithinBudget(db, env, { tier: opts.tier, callerRef: opts.callerRef });

  // Call run() as a MEMBER of env.AI — detaching it (const run = env.AI.run) loses
  // `this`, and the binding's internals throw "Cannot set properties of undefined
  // (setting '#options')". Verified live on Workers 2026-06-21.
  const ai = env.AI as unknown as { run: AiRun };
  const result = await ai.run(opts.model, opts.inputs, {
    gateway: { id: env.AI_GATEWAY_ID, skipCache: opts.tier === "t2" },
  });

  const { tokensIn, tokensOut } = tokensOf(result, promptTextOf(opts.inputs));
  const usd = costUsd(opts.model, tokensIn, tokensOut);
  await db
    .insert(inferenceCosts)
    .values({
      model: opts.model,
      route: opts.route,
      tier: opts.tier,
      callerRef: opts.callerRef ?? "system",
      tokensIn,
      tokensOut,
      neurons: usd / 0.011, // $0.011 per 1k neurons → neurons ≈ usd/0.011*1000; store rough
      usd,
      day: utcDay(),
    })
    .run();

  return result;
}
