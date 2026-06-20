/**
 * Zero-dependency Sentry error reporter. Parses a standard DSN and POSTs an event to
 * Sentry's store endpoint. No-op until `SENTRY_DSN` is set, so it ships dark and turns
 * on the moment the founder adds the secret — no SDK, no test-runtime risk. (Upgrade to
 * @sentry/cloudflare for tracing/breadcrumbs once the test runtime is bumped post-sim.)
 */
import type { Env } from "./env";

export async function captureError(
  env: Env,
  err: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  const dsn = env.SENTRY_DSN;
  if (!dsn) return; // dark until configured
  try {
    const m = dsn.match(/^https:\/\/([^@]+)@([^/]+)\/(.+)$/);
    if (!m) return;
    const [, key, host, projectId] = m;
    const e = err as Error;
    const event = {
      event_id: crypto.randomUUID().replace(/-/g, ""),
      timestamp: new Date().toISOString(),
      platform: "javascript",
      level: "error",
      logger: "datebook",
      server_name: "datebook-staging",
      environment: env.SIM_MODE,
      exception: {
        values: [{ type: e?.name ?? "Error", value: e?.message ?? String(err) }],
      },
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
