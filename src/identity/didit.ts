/**
 * Didit identity verification (adult/ID check before any contact reveal).
 * Webhook verification follows the Didit spec: X-Signature (HMAC-SHA256 over the EXACT raw
 * body — Workers don't re-encode c.req.text(), so raw is reliable), X-Timestamp freshness
 * (±300s), and CONSTANT-TIME comparison. Disabled (no-op) until DIDIT_* env is set.
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
  eventId?: string;
  sessionId?: string;
  vendorData?: string;
  webhookType?: string;
  status?: string; // raw Didit status ("Approved" | "Declined" | ...)
  verified?: boolean; // Approved (+ adult per workflow)
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
        vendor_data: String(input.ownerId), // echoed back in the webhook → maps result → owner
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

const enc = (s: string) => new TextEncoder().encode(s);
const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Constant-time hex string comparison (prevents signature timing attacks). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Best-effort adult signal from the V3 decision. The Didit workflow MUST be configured to
 *  require 18+ so an "Approved" already implies adult; this is defense-in-depth. */
function ageOver18From(decision: unknown): boolean {
  const d = decision as { id_verifications?: Array<{ age?: number; date_of_birth?: string; dob?: string }>; age_over_18?: boolean } | undefined;
  if (!d) return false;
  if (typeof d.age_over_18 === "boolean") return d.age_over_18;
  const idv = Array.isArray(d.id_verifications) ? d.id_verifications[0] : undefined;
  if (idv) {
    if (typeof idv.age === "number") return idv.age >= 18;
    const dob = idv.date_of_birth ?? idv.dob;
    if (typeof dob === "string") {
      const t = Date.parse(dob);
      if (!Number.isNaN(t)) return (Date.now() - t) / (365.25 * 86_400_000) >= 18;
    }
  }
  return false;
}

export async function verifyDiditWebhook(
  env: Env,
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
): Promise<WebhookResult> {
  if (!env.DIDIT_WEBHOOK_SECRET) return { ok: false, reason: "didit webhook not configured" };
  if (!signature) return { ok: false, reason: "missing signature" };

  // 1. Freshness: |now - X-Timestamp| <= 300s.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) {
    return { ok: false, reason: "stale or missing timestamp" };
  }

  try {
    // 2. Recompute HMAC over the exact raw bytes; 3. constant-time compare.
    const key = await crypto.subtle.importKey("raw", enc(env.DIDIT_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, enc(rawBody));
    if (!constantTimeEqual(toHex(mac), signature.trim().toLowerCase())) {
      return { ok: false, reason: "bad signature" };
    }

    // 4. Parse only AFTER signature passes.
    const body = JSON.parse(rawBody) as {
      event_id?: string;
      session_id?: string;
      status?: string;
      webhook_type?: string;
      vendor_data?: string;
      decision?: unknown;
    };
    const ageOver18 = ageOver18From(body.decision);
    return {
      ok: true,
      eventId: body.event_id,
      sessionId: body.session_id,
      vendorData: body.vendor_data,
      webhookType: body.webhook_type,
      status: body.status,
      ageOver18,
      verified: body.status === "Approved", // adult enforced by the workflow config
    };
  } catch (e) {
    return { ok: false, reason: `didit_error: ${(e as Error).message}` };
  }
}
