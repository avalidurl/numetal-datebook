/**
 * Chaperone orchestrator — the fail-closed safety gate on every publish path.
 * Order: denylist (T0) → PII hold (publish only, T0) → Llama-Guard classifier (T1).
 * Every decision is written to chaperone_decisions (durable audit — audit fix).
 * Verdict vocabulary matches the 06-19 refresh: allow|sanitize|hold|deny|escalate_identity|reveal_ready.
 */
import type { DB } from "../db/client";
import { chaperoneDecisions, events } from "../db/schema";
import type { Env } from "../env";
import { llamaGuard, type GuardResult } from "./guard";
import { childSafetyHit, denylistHit, leakHold, redactPII } from "./patterns";

export type Verdict = "allow" | "sanitize" | "hold" | "deny" | "escalate_identity" | "reveal_ready";
export type Stage =
  | "admission"
  | "pre_publish"
  | "pre_turn"
  | "pre_payment_output"
  | "report_review"
  | "chat_input"
  | "chat_output";

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
  /** The text safe to publish: original on `allow`, redacted on `sanitize`. Absent on hold/deny. */
  text?: string;
}

/** High-severity child-safety signal → events table, for the operator + CSAM-reporting path. */
async function flagChildSafety(db: DB, a: ChaperoneArgs, category: string): Promise<void> {
  await db
    .insert(events)
    .values({
      kind: "child_safety_block",
      payload: JSON.stringify({ stage: a.stage, target: `${a.targetType}#${a.targetId}`, category, callerRef: a.callerRef ?? null }),
    })
    .run()
    .catch(() => {});
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
  // Gate 1: denylist (deny-hard). Minor-coded framing is hard-denied AND flagged child-safety.
  if (denylistHit(a.text)) {
    const child = childSafetyHit(a.text);
    const r = child ? "child_safety: minor-coded/non-consent framing denied" : "denylist: prohibited framing";
    await record(db, a, "deny", r, null, null);
    if (child) await flagChildSafety(db, a, "denylist_minor");
    return { verdict: "deny", reason: r };
  }

  // Gate 2: PII/secret on publish paths → sanitize (redact + publish) if we can confidently
  // redact, else HOLD (fail-safe). Admission/report-review are not publish paths.
  const publishStage = a.stage === "pre_publish" || a.stage === "pre_turn";
  if (publishStage && leakHold(a.text)) {
    const { redacted, hits } = redactPII(a.text);
    if (hits > 0) {
      const r = `pii: redacted ${hits} span(s)`;
      await record(db, a, "sanitize", r, null, null);
      return { verdict: "sanitize", reason: r, text: redacted };
    }
    const r = "pii: held for review";
    await record(db, a, "hold", r, null, null);
    return { verdict: "hold", reason: r };
  }

  // Gate 3: Llama-Guard classifier (fail-closed).
  const guard = deps?.guard ?? llamaGuard;
  const g = await guard(db, env, a.text, `chaperone:${a.stage}`, a.callerRef);
  if (!g.safe) {
    const isErr = g.category === "error" || g.category === "unparseable";
    const isChild = (g.category ?? "").toUpperCase() === "S4"; // child sexual exploitation
    // S4 is ALWAYS a hard deny — never the recoverable hold, even if signal is otherwise
    // ambiguous. Classifier could not run → HOLD (fail-closed). Other confirmed unsafe → DENY.
    const verdict: Verdict = isChild ? "deny" : isErr ? "hold" : "deny";
    const r = isChild
      ? "child_safety: S4 (child sexual exploitation) denied"
      : isErr
        ? `guard_unavailable: ${g.category}`
        : `guard_unsafe: ${g.category ?? "flagged"}`;
    await record(db, a, verdict, r, env.GUARD_MODEL, g.raw);
    if (isChild) await flagChildSafety(db, a, "guard_S4");
    return { verdict, reason: r };
  }

  await record(db, a, "allow", "passed", env.GUARD_MODEL, g.raw);
  return { verdict: "allow", reason: "passed", text: a.text };
}
