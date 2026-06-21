/**
 * Cloudflare-native error capture — no external SaaS required (this is the "Sentry" for an
 * all-Cloudflare stack). In order:
 *   1. ALWAYS console.error a structured line → Cloudflare **Workers Logs** (real-time +
 *      searchable in the dash, and Logpush-able to R2 for retention). Free, on by default.
 *   2. If ALERT_WEBHOOK_URL is set → POST a compact alert (Slack-compatible) for real-time paging.
 *   3. If SENTRY_DSN is set → also forward to Sentry (optional parity; NOT required).
 * Context objects carry only routing metadata (where / route / ids) — never heart-file content.
 */
import type { Env } from "./env";

export async function captureError(
  env: Env,
  err: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  const e = err as Error;
  const ts = new Date().toISOString();
  const evt = {
    ts,
    level: "error",
    logger: "datebook",
    environment: env.SIM_MODE,
    type: e?.name ?? "Error",
    message: e?.message ?? String(err),
    ...context,
  };

  // 1) Workers Logs (always) — the CF-native sink.
  console.error("datebook.error " + JSON.stringify({ ...evt, stack: e?.stack }));

  // 2) Optional real-time alert to a Slack-compatible webhook.
  if (env.ALERT_WEBHOOK_URL) {
    try {
      await fetch(env.ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `🚨 datebook (${evt.environment}) ${evt.type}: ${evt.message} · ${JSON.stringify(context)}`,
        }),
      });
    } catch {
      /* never break the request path on alerting */
    }
  }

  // 3) Optional Sentry (only if a DSN is configured) — kept for parity, not needed.
  const dsn = env.SENTRY_DSN;
  if (dsn) {
    try {
      const m = dsn.match(/^https:\/\/([^@]+)@([^/]+)\/(.+)$/);
      if (!m) return;
      const [, key, host, projectId] = m;
      const event = {
        event_id: crypto.randomUUID().replace(/-/g, ""),
        timestamp: ts,
        platform: "javascript",
        level: "error",
        logger: "datebook",
        server_name: "datebook-staging",
        environment: env.SIM_MODE,
        exception: { values: [{ type: evt.type, value: evt.message }] },
        extra: { ...context, stack: e?.stack },
      };
      await fetch(`https://${host}/api/${projectId}/store/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sentry-auth": `Sentry sentry_version=7, sentry_client=datebook/1.0, sentry_key=${key}`,
        },
        body: JSON.stringify(event),
      });
    } catch {
      /* telemetry must never break the request path */
    }
  }
}
