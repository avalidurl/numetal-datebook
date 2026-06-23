/**
 * Retention sweeper (audit storage fix) — bounds the high-churn tables so D1 never
 * walks toward the 10 GB wall or the rows-read bill. Runs on the hourly cron janitor.
 * Archive-to-R2 is post-MVP; here we keep a rolling RETENTION_DAYS window.
 */
import type { Env } from "./env";

export async function sweepRetention(env: Env): Promise<{ deleted: number }> {
  const days = Number(env.RETENTION_DAYS || "30");
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const e = await env.DB.prepare("DELETE FROM events WHERE created_at < ?1").bind(cutoff).run();
  const i = await env.DB.prepare("DELETE FROM inference_costs WHERE created_at < ?1").bind(cutoff).run();
  const a = await env.DB.prepare("DELETE FROM access_denials WHERE created_at < ?1").bind(cutoff).run();
  const x = await env.DB.prepare("DELETE FROM error_events WHERE created_at < ?1").bind(cutoff).run();
  // Relay sessions hold the (encrypted) age-verification secrets — purge aggressively on a 7-day TTL,
  // independent of the general retention window (red-team M5). Sessions are also consumed in ~15 min.
  const relayCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const rs = await env.DB.prepare("DELETE FROM relay_sessions WHERE created_at < ?1").bind(relayCutoff).run();
  return { deleted: (e.meta.changes ?? 0) + (i.meta.changes ?? 0) + (a.meta.changes ?? 0) + (x.meta.changes ?? 0) + (rs.meta.changes ?? 0) };
}
