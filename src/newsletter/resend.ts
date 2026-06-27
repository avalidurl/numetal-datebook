/**
 * Resend newsletter client. Two jobs: (1) on subscribe, add the contact to the Resend audience;
 * (2) on publish, send a blog post as a Broadcast to that audience (Resend handles unsubscribe).
 * All best-effort + fail-soft: a Resend hiccup must never break a signup or a venue request.
 * Dark until RESEND_API_KEY + RESEND_AUDIENCE_ID are set (the whole module no-ops).
 */
import type { Env } from "../env";

const BASE = "https://api.resend.com";

function ready(env: Env): boolean {
  return !!(env.RESEND_API_KEY && env.RESEND_AUDIENCE_ID);
}
function headers(env: Env): Record<string, string> {
  return { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" };
}

/** Add (or re-activate) a newsletter contact in the Resend audience. Idempotent on Resend's side. */
export async function resendAddContact(env: Env, email: string): Promise<{ ok: boolean; skipped?: boolean; status?: number }> {
  if (!ready(env)) return { ok: false, skipped: true };
  try {
    const r = await fetch(`${BASE}/audiences/${env.RESEND_AUDIENCE_ID}/contacts`, {
      method: "POST",
      headers: headers(env),
      body: JSON.stringify({ email, unsubscribed: false }),
    });
    return { ok: r.ok, status: r.status }; // 200/201 created, 409-ish if already present — both fine
  } catch {
    return { ok: false };
  }
}

/** Create + send a Broadcast to the audience. Resend appends the unsubscribe footer automatically. */
export async function resendSendBroadcast(
  env: Env,
  msg: { subject: string; html: string },
): Promise<{ ok: boolean; broadcastId?: string; reason?: string }> {
  if (!ready(env)) return { ok: false, reason: "resend not configured" };
  const from = env.NEWSLETTER_FROM || "Ishtar <ishtar@numetal.xyz>";
  try {
    const create = await fetch(`${BASE}/broadcasts`, {
      method: "POST",
      headers: headers(env),
      body: JSON.stringify({ audience_id: env.RESEND_AUDIENCE_ID, from, subject: msg.subject, html: msg.html }),
    });
    const cj = (await create.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!create.ok || !cj.id) return { ok: false, reason: cj.message || `create ${create.status}` };
    const send = await fetch(`${BASE}/broadcasts/${cj.id}/send`, { method: "POST", headers: headers(env) });
    if (!send.ok) {
      const sj = (await send.json().catch(() => ({}))) as { message?: string };
      return { ok: false, broadcastId: cj.id, reason: sj.message || `send ${send.status}` };
    }
    return { ok: true, broadcastId: cj.id };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "fetch failed" };
  }
}

const esc = (s: string) =>
  String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] as string);

/** Minimal, on-brand HTML for a dispatch: title, dek, read-link. Black/white/red, system fonts. */
export function dispatchHtml(post: { title: string; description: string; url: string }): string {
  return `<!doctype html><html><body style="margin:0;background:#fff;color:#0a0a0a;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:540px;margin:0 auto;padding:28px 22px">
    <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#6a6a6a">Ishtar &#9829; dispatches</div>
    <h1 style="font-size:24px;line-height:1.15;margin:10px 0 6px;font-weight:700">${esc(post.title)}</h1>
    <p style="font-size:15px;line-height:1.55;color:#333;margin:0 0 20px">${esc(post.description)}</p>
    <a href="${esc(post.url)}" style="display:inline-block;background:#e10600;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 18px">Read it &rarr;</a>
    <hr style="border:0;border-top:1px solid #eee;margin:26px 0 12px" />
    <div style="font-size:12px;color:#9a9a9a">You're getting this because you subscribed at ishtar.numetal.xyz. Agents date; you meet only when it's real.</div>
  </div></body></html>`;
}
