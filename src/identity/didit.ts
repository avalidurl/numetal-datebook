/**
 * Didit identity verification (adult/ID check before any contact reveal). createSession
 * kicks off a hosted Didit flow; verifyWebhook validates the HMAC-signed result callback.
 * DISABLED until DIDIT_API_KEY / DIDIT_WEBHOOK_SECRET are set (no-op, fail-closed).
 * Stores only pass/fail + age-over-18 + expiry — never raw documents.
 */
import type { Env } from "../env";

const DIDIT_API = "https://verification.didit.me/v2/session/";

export interface SessionResult {
  ok: boolean;
  sessionId?: string;
  url?: string;
  reason?: string;
}

export interface WebhookResult {
  ok: boolean;
  sessionId?: string;
  status?: "verified" | "failed";
  ageOver18?: boolean;
  reason?: string;
}

export async function createDiditSession(
  env: Env,
  input: { ownerId: number; coupleId?: number; callbackUrl?: string },
): Promise<SessionResult> {
  if (!env.DIDIT_API_KEY || !env.DIDIT_WORKFLOW_ID) return { ok: false, reason: "didit not configured" };
  try {
    const res = await fetch(DIDIT_API, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.DIDIT_API_KEY },
      body: JSON.stringify({
        workflow_id: env.DIDIT_WORKFLOW_ID,
        vendor_data: String(input.ownerId),
        callback: input.callbackUrl,
        metadata: { coupleId: input.coupleId },
      }),
    });
    if (!res.ok) return { ok: false, reason: `didit ${res.status}` };
    const j = (await res.json()) as { session_id?: string; url?: string; session_url?: string };
    return { ok: true, sessionId: j.session_id, url: j.url ?? j.session_url };
  } catch (e) {
    return { ok: false, reason: `didit_error: ${(e as Error).message}` };
  }
}

export async function verifyDiditWebhook(
  env: Env,
  rawBody: string,
  signature: string | undefined,
): Promise<WebhookResult> {
  if (!env.DIDIT_WEBHOOK_SECRET) return { ok: false, reason: "didit webhook not configured" };
  if (!signature) return { ok: false, reason: "missing signature" };
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.DIDIT_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== signature.toLowerCase()) return { ok: false, reason: "bad signature" };

    const body = JSON.parse(rawBody) as {
      session_id?: string;
      status?: string;
      decision?: { age_estimation?: { age_over_18?: boolean }; id_verification?: { age?: number } };
    };
    const approved = (body.status ?? "").toLowerCase() === "approved";
    const age = body.decision?.id_verification?.age;
    const ageOver18 = body.decision?.age_estimation?.age_over_18 ?? (age != null ? age >= 18 : false);
    return {
      ok: true,
      sessionId: body.session_id,
      status: approved && ageOver18 ? "verified" : "failed",
      ageOver18,
    };
  } catch (e) {
    return { ok: false, reason: `didit_error: ${(e as Error).message}` };
  }
}
