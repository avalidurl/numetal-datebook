/**
 * Chaperone orchestrator — the fail-closed safety gate on every publish path.
 * Order: denylist (T0) → PII hold (publish only, T0) → Llama-Guard classifier (T1).
 * Every decision is written to chaperone_decisions (durable audit — audit fix).
 * Verdict vocabulary matches the 06-19 refresh: allow|sanitize|hold|deny|escalate_identity|reveal_ready.
 */
import type { DB } from "../db/client";
import { chaperoneDecisions } from "../db/schema";
import type { Env } from "../env";
import { llamaGuard, type GuardResult } from "./guard";
import { denylistHit, leakHold } from "./patterns";

export type Verdict = "allow" | "sanitize" | "hold" | "deny" | "escalate_identity" | "reveal_ready";
export type Stage = "admission" | "pre_publish" | "pre_turn" | "pre_payment_output" | "report_review";

/** The classifier function (default: Llama-Guard). Injectable so tests can stub the
 *  remote model without weakening the production fail-closed default. */
export type GuardFn = (
  db: DB,
  env: Env,
  text: string,
  route: string,
  callerRef?: string,
) => Promise<GuardResult>;

export interface ChaperoneArgs {
  stage: Stage;
  targetType: string; // owner|persona|heart_file|post|turn|couple|premium_output
  targetId: number;
  text: string;
  callerRef?: string;
}

export interface ChaperoneResult {
  verdict: Verdict;
  reason: string;
}

async function record(
  db: DB,
  a: ChaperoneArgs,
  verdict: Verdict,
  reason: string,
  model: string | null,
  raw: string | null,
): Promise<void> {
  await db
    .insert(chaperoneDecisions)
    .values({
      targetType: a.targetType,
      targetId: a.targetId,
      stage: a.stage,
      verdict,
      reason,
      model,
      rawJson: raw,
    })
    .run();
}

/**
 * Run the full chaperone for one artifact. Returns the verdict and persists it.
 * Only `allow` (and `reveal_ready`, set elsewhere) should let an artifact publish.
 */
export async function chaperone(
  db: DB,
  env: Env,
  a: ChaperoneArgs,
  deps?: { guard?: GuardFn },
): Promise<ChaperoneResult> {
  // Gate 1: denylist (deny-hard).
  if (denylistHit(a.text)) {
    const r = "denylist: prohibited framing";
    await record(db, a, "deny", r, null, null);
    return { verdict: "deny", reason: r };
  }

  // Gate 2: PII/secret hold on publish paths.
  const publishStage = a.stage === "pre_publish" || a.stage === "pre_turn";
  if (publishStage && leakHold(a.text)) {
    const r = "pii: held for review";
    await record(db, a, "hold", r, null, null);
    return { verdict: "hold", reason: r };
  }

  // Gate 3: Llama-Guard classifier (fail-closed).
  const guard = deps?.guard ?? llamaGuard;
  const g = await guard(db, env, a.text, `chaperone:${a.stage}`, a.callerRef);
  if (!g.safe) {
    const isErr = g.category === "error" || g.category === "unparseable";
    // Classifier could not run → HOLD (fail-closed, recoverable). Confirmed unsafe → DENY.
    const verdict: Verdict = isErr ? "hold" : "deny";
    const r = isErr ? `guard_unavailable: ${g.category}` : `guard_unsafe: ${g.category ?? "flagged"}`;
    await record(db, a, verdict, r, env.GUARD_MODEL, g.raw);
    return { verdict, reason: r };
  }

  await record(db, a, "allow", "passed", env.GUARD_MODEL, g.raw);
  return { verdict: "allow", reason: "passed" };
}
