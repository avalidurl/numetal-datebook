/**
 * Shared compatibility-report generation — the ground-decrypt + generate + chaperone + persist steps,
 * factored out of the paid route so the paid path (src/routes/premium.ts) and the paid-report re-fetch
 * path use ONE implementation and can never drift.
 *
 * SECURITY: `groundCouple` DECRYPTS both personas' private hearts. Callers MUST authorize couple
 * membership (src/premium/report-authz.ts) BEFORE calling it — this module does no authorization.
 */
import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { events, premiumOrders } from "../db/schema";
import type { Env } from "../env";
import { chaperone } from "../chaperone";
import { open } from "../crypto/box";
import { runGuarded } from "../economics/gateway";
import { textOf } from "../economics/pricing";
import { SKUS } from "../payments/x402";

/** Build the grounding block for a couple: decrypt both hearts + up to 24 published courtship turns.
 * Returns "" when no couple is named or the couple does not exist. AUTHORIZATION IS THE CALLER'S JOB. */
export async function groundCouple(env: Env, coupleId: number | null | undefined): Promise<string> {
  if (!coupleId) return "";
  const cr = await env.DB.prepare("SELECT a_id AS aId, b_id AS bId FROM couples WHERE id=?1").bind(coupleId).first<{ aId: number; bId: number }>();
  if (!cr) return "";
  const pa = await env.DB.prepare("SELECT handle, heart_json FROM personas WHERE id=?1").bind(cr.aId).first<{ handle: string; heart_json: string }>();
  const pb = await env.DB.prepare("SELECT handle, heart_json FROM personas WHERE id=?1").bind(cr.bId).first<{ handle: string; heart_json: string }>();
  const ha = (await open(env, pa?.heart_json ?? null)) ?? "";
  const hb = (await open(env, pb?.heart_json ?? null)) ?? "";
  const tr = (await env.DB.prepare("SELECT body FROM turns WHERE couple_id=?1 AND status='published' ORDER BY turn_seq ASC LIMIT 24").bind(coupleId).all()).results as Array<{ body: string }>;
  return (
    `\n\nDating doc A (@${pa?.handle ?? "a"}):\n${ha}\n\nDating doc B (@${pb?.handle ?? "b"}):\n${hb}` +
    (tr.length ? `\n\nTheir courtship so far:\n${tr.map((t) => t.body).join("\n")}` : "")
  );
}

export type ReportResult =
  | { status: "ok"; report: string; sanitized?: boolean }
  | { status: "withheld"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Generate the report from `grounding` (or an ungrounded prompt when empty), chaperone the output, and
 * persist the outcome onto the order (reportText on success; status='failed' on empty/withheld). Mirrors
 * the original inline behavior exactly: two generation attempts, fail-closed chaperone, deliver-sanitized.
 */
export async function generateAndStoreReport(
  db: DB,
  env: Env,
  args: { ownerId: number; coupleId?: number | null; orderId: string; grounding: string },
): Promise<ReportResult> {
  const { ownerId, orderId, grounding } = args;
  const sku = SKUS.compatibility_report!;
  const prompt = grounding
    ? `You are Ishtar, the venue's matchmaker. Write a warm, specific, evidence-grounded compatibility report (6-10 sentences) for this couple, drawn ENTIRELY from their two dating docs and their courtship below. Name concrete resonances and the texture each brings, and — REQUIRED — name at least one honest tension or friction worth watching (a report that is pure affirmation is incomplete). Finish your sentences; do not trail off. Adults; no real-world PII (no real names, contacts, or locations).${grounding}`
    : `Write a concise compatibility report (5-8 sentences) for owner ${ownerId}. Be specific, warm, evidence-oriented. No PII.`;

  // A paid/comped report must NEVER silently be empty: retry once, then fail loudly (not a fake "ok").
  const genOnce = async () =>
    textOf(
      await runGuarded(db, env, {
        model: env.REPORT_MODEL,
        tier: "t2",
        route: sku.route,
        callerRef: `owner:${ownerId}`,
        paid: true,
        inputs: { messages: [{ role: "user", content: prompt }], max_tokens: 1200 },
      }),
    ).trim();
  let reportText = await genOnce();
  if (!reportText) reportText = await genOnce();
  if (!reportText) {
    await db.update(premiumOrders).set({ status: "failed" }).where(eq(premiumOrders.orderId, orderId)).run();
    return { status: "failed", reason: "report generation failed — nothing delivered" };
  }

  // Chaperone the paid OUTPUT — every artifact the venue emits is safety-checked. Fail-closed: withhold.
  const verdict = await chaperone(db, env, {
    stage: "pre_payment_output",
    targetType: "premium_output",
    targetId: ownerId,
    text: reportText,
    callerRef: `owner:${ownerId}`,
  });
  if (verdict.verdict !== "allow" && verdict.verdict !== "sanitize") {
    await db.update(premiumOrders).set({ status: "failed" }).where(eq(premiumOrders.orderId, orderId)).run();
    await db.insert(events).values({ kind: "paid_output_withheld", payload: JSON.stringify({ orderId, reason: verdict.reason }) }).run();
    return { status: "withheld", reason: `held for review: ${verdict.reason}` };
  }
  // Persist the delivered artifact (re-fetchable + a durable record of what was sent). Status is left as
  // the caller set it (settle→'fulfilled', comp→'comped') — the re-fetch re-gen path restores it explicitly.
  const delivered = verdict.text ?? reportText;
  await db.update(premiumOrders).set({ reportText: delivered }).where(eq(premiumOrders.orderId, orderId)).run();
  return { status: "ok", report: delivered, sanitized: verdict.verdict === "sanitize" || undefined };
}
