/**
 * Pluggable match-notify layer.
 *
 * WHAT: when something an enrolled human cares about happens (today: a MATCH — a couple forms that
 * involves their owner), notify them out-of-band over their enabled channels. The first and only
 * wired channel is EMAIL (decrypt the owner's sealed contact → Resend). Every other channel
 * (xmtp, telegram, imessage, whatsapp, signal) ships as a clearly-marked STUB so a future branch
 * just fills `send()` — the registry, the trigger, the idempotency ledger, and the email copy are
 * already done.
 *
 * SHAPE: a `NotifyChannel` is `{ name, canSend(env, owner), send(env, owner, msg) }`. `notifyOwner`
 * resolves the owner's enabled channels (owners.alert_channels CSV, default ['email']), and for each
 * one claims an idempotency row in `notifications` (UNIQUE(owner,kind,ref,channel)) BEFORE sending, so
 * a replayed/re-entered match beat can never double-send. This alert is "come look", NOT contact —
 * contact stays reveal-gated in identity.ts.
 *
 * This module NEVER throws to its caller: the match coordinator wraps the call in try/catch too, but
 * notifyOwner additionally swallows its own errors so a notify failure can never break matching.
 */
import type { Env } from "../env";
import { open } from "../crypto/box";
import { resendSend } from "../newsletter/resend";

/** The owner being notified. `contactRef` is the SEALED contact pointer (may be an "email:" / raw email). */
export interface NotifyOwner {
  id: number;
  displayName?: string | null;
  contactRef?: string | null; // sealed (enc:v1:…) or legacy plaintext; opened by the email adapter
  alertChannels?: string | null; // CSV of enabled channel names; null/empty → ['email']
}

/** The message a channel delivers. `url` is the "come look" link (the matches page magic-link). */
export interface NotifyMessage {
  subject: string;
  text: string;
  html?: string;
  url?: string;
}

/** A pluggable delivery channel. Add one by implementing this and registering it below. */
export interface NotifyChannel {
  name: string;
  /** Can this channel deliver to this owner right now? (config present + a usable address). */
  canSend(env: Env, owner: NotifyOwner): boolean | Promise<boolean>;
  /** Deliver. MUST NOT throw — return {ok:false, reason} on any failure (fail-soft). */
  send(env: Env, owner: NotifyOwner, msg: NotifyMessage): Promise<{ ok: boolean; reason?: string }>;
}

/* --------------------------------------------------------------------- email (the one wired channel) */

/** Pull a deliverable email out of the owner's (possibly sealed) contactRef. Accepts a raw email or a
 *  "email:foo@bar" / "mailto:foo@bar" prefixed pointer. Returns null if there's no email-shaped value. */
async function ownerEmail(env: Env, owner: NotifyOwner): Promise<string | null> {
  const opened = (await open(env, owner.contactRef ?? null)) ?? "";
  const raw = opened.replace(/^(email:|mailto:)/i, "").trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw) ? raw : null;
}

const emailChannel: NotifyChannel = {
  name: "email",
  async canSend(env, owner) {
    if (!env.RESEND_API_KEY) return false; // Resend dark → can't send
    return (await ownerEmail(env, owner)) != null;
  },
  async send(env, owner, msg) {
    const to = await ownerEmail(env, owner);
    if (!to) return { ok: false, reason: "no email contact" };
    const r = await resendSend(env, { to, subject: msg.subject, text: msg.text, html: msg.html });
    return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? (r.skipped ? "resend skipped" : "send failed") };
  },
};

/* --------------------------------------------------------------------- STUB channels (fill these later)
 * Each stub is a no-op that returns {ok:false, reason:'not-implemented'} and reports canSend=false, so
 * the dispatcher never selects it (and never records a phantom send). A future branch implements the
 * adapter for its medium and flips canSend to a real check. The XMTP adapter, when built, will relay
 * via the existing XMTP brain/listener (see src/xmtp/README.md) — POST {conversationId, text} to the
 * brain Worker and let the listener (which holds the signer) deliver. Telegram/iMessage/WhatsApp/Signal
 * follow the same shape: resolve the owner's handle for that medium, then call the medium's send API.
 */
function makeStub(name: string): NotifyChannel {
  return {
    name,
    // TODO(<channel>): implement a real readiness check (creds present + owner has a <channel> address).
    canSend() {
      return false;
    },
    // TODO(<channel>): implement delivery for this medium and return {ok:true} on success.
    async send() {
      return { ok: false, reason: "not-implemented" };
    },
  };
}

const xmtpChannel = makeStub("xmtp");
const telegramChannel = makeStub("telegram");
const imessageChannel = makeStub("imessage");
const whatsappChannel = makeStub("whatsapp");
const signalChannel = makeStub("signal");

/* --------------------------------------------------------------------- registry */

/** The channel registry. Lookup is by lowercase name; email is the only live channel for now. */
export const channelRegistry: Record<string, NotifyChannel> = {
  email: emailChannel,
  xmtp: xmtpChannel,
  telegram: telegramChannel,
  imessage: imessageChannel,
  whatsapp: whatsappChannel,
  signal: signalChannel,
};

/** Resolve a channel by name (case-insensitive). */
export function getChannel(name: string): NotifyChannel | undefined {
  return channelRegistry[name.trim().toLowerCase()];
}

/** Parse the owner's enabled channels (CSV), defaulting to ['email'] when empty/absent. */
export function enabledChannels(owner: NotifyOwner): string[] {
  const csv = (owner.alertChannels ?? "").trim();
  if (!csv) return ["email"];
  const names = csv
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return names.length ? names : ["email"];
}

/* --------------------------------------------------------------------- match-token (self-contained link)
 *
 * The matches page is minted by the sibling matches-page branch; for a self-contained email THIS branch
 * mints the magic-link token so the alert works before that branch lands. The matches-page branch MUST
 * verify with this exact scheme:
 *
 *   token   = "v1." + body64 + "." + sig64
 *   body64  = base64url( utf8( JSON.stringify({ o: <ownerId:number>, exp: <unixSeconds:number> }) ) )
 *   sig64   = base64url( HMAC_SHA256( key, "v1." + body64 ) )      // signed input INCLUDES the "v1." prefix
 *   key     = utf8( env.NOTIFY_TOKEN_SECRET || env.ENCRYPTION_KEY ) // raw UTF-8 bytes of the secret string
 *
 * base64url = standard base64 with +→-, /→_, and '=' padding stripped. JSON key order is exactly {o,exp}.
 * Verify = recompute sig64 over "v1."+body64 (constant-time compare) AND check exp > now. Default TTL 7d.
 */

const b64urlEncode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlDecode = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad), (c) => c.charCodeAt(0));
};

function tokenKey(env: Env): string {
  return (env.NOTIFY_TOKEN_SECRET || env.ENCRYPTION_KEY || "").trim();
}

async function hmac(env: Env, signingInput: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(tokenKey(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)));
}

/** Mint an HMAC-signed, expiring magic-link token for {ownerId}. Default TTL 7 days. */
export async function mintMatchToken(env: Env, ownerId: number, ttlSeconds = 7 * 24 * 3600): Promise<string> {
  const payload = { o: ownerId, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig64 = b64urlEncode(await hmac(env, `v1.${body64}`));
  return `v1.${body64}.${sig64}`;
}

/**
 * Verify a match token. Returns the ownerId on success, or null if the signature is bad, the token is
 * malformed, or it has expired. Provided here so this branch is self-checking; the matches-page branch
 * may reuse it verbatim (same scheme).
 */
export async function verifyMatchToken(env: Env, token: string): Promise<{ ownerId: number } | null> {
  const parts = (token ?? "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, body64, sig64] = parts as [string, string, string];
  let expected: Uint8Array;
  try {
    expected = await hmac(env, `v1.${body64}`);
  } catch {
    return null;
  }
  let got: Uint8Array;
  try {
    got = b64urlDecode(sig64);
  } catch {
    return null;
  }
  if (got.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= got[i]! ^ expected[i]!; // constant-time compare
  if (diff !== 0) return null;
  let payload: { o?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body64)));
  } catch {
    return null;
  }
  const ownerId = Number(payload.o);
  const exp = Number(payload.exp);
  if (!Number.isInteger(ownerId) || ownerId <= 0) return null;
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return null; // expired
  return { ownerId };
}

/** Build the matches-page magic-link for an owner: <site>/matches/?token=<mintMatchToken>. */
export async function matchesUrl(env: Env, ownerId: number): Promise<string> {
  const site = (env.PUBLIC_SITE_URL || "https://ishtar.numetal.xyz").replace(/\/+$/, "");
  const token = await mintMatchToken(env, ownerId);
  return `${site}/matches/?token=${encodeURIComponent(token)}`;
}

/* --------------------------------------------------------------------- email copy (Ishtar voice) */

const esc = (s: string) =>
  String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] as string);

/** The "you have a match — come look" alert. Ishtar's warm voice; black/white/red, system fonts. */
export function matchAlertEmail(url: string): { subject: string; text: string; html: string } {
  const subject = "You have a match on Ishtar";
  const text = `You have a match on Ishtar — your agent found someone. See who: ${url}`;
  const html = `<!doctype html><html><body style="margin:0;background:#fff;color:#0a0a0a;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:540px;margin:0 auto;padding:28px 22px">
    <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#6a6a6a">Ishtar &#9829; the floor</div>
    <h1 style="font-size:24px;line-height:1.15;margin:10px 0 14px;font-weight:700">You have a match</h1>
    <p style="font-size:15px;line-height:1.6;color:#222;margin:0 0 18px">Your agent found someone on Ishtar. See who &mdash; the introduction opens only when it&rsquo;s real.</p>
    <a href="${esc(url)}" style="display:inline-block;background:#e10600;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 18px">See your match &rarr;</a>
    <p style="font-size:15px;line-height:1.6;color:#222;margin:18px 0 0">&mdash; Ishtar</p>
    <hr style="border:0;border-top:1px solid #eee;margin:26px 0 12px" />
    <div style="font-size:12px;color:#9a9a9a">You&rsquo;re getting this because you joined Ishtar via a featured post. This is a "come look" alert &mdash; contact is shared only when both sides confirm.</div>
  </div></body></html>`;
  return { subject, text, html };
}

/* --------------------------------------------------------------------- the dispatcher */

/**
 * Notify an owner over each of their enabled channels, idempotently.
 *
 * For each channel: INSERT a claim row into `notifications` (ON CONFLICT DO NOTHING on
 * UNIQUE(owner,kind,ref,channel)). If the claim is lost, this (owner,kind,ref,channel) was already
 * handled → skip (idempotent: a replayed/re-entered beat sends nothing twice). If the claim is won,
 * call the channel's send() and UPDATE the row's status/reason with the outcome.
 *
 * `payload` for kind='match' is { coupleId, matchesUrl }. NEVER throws — a notify failure must never
 * break matching.
 */
export async function notifyOwner(
  d1: D1Database,
  env: Env,
  ownerId: number,
  kind: string,
  payload: { coupleId?: number; matchesUrl?: string },
): Promise<{ attempted: string[]; sent: string[]; skipped: string[] }> {
  const out = { attempted: [] as string[], sent: [] as string[], skipped: [] as string[] };
  try {
    const owner = (await d1
      .prepare("SELECT id, display_name, contact_ref, alert_channels FROM owners WHERE id = ?1")
      .bind(ownerId)
      .first()) as
      | { id: number; display_name: string | null; contact_ref: string | null; alert_channels: string | null }
      | null;
    if (!owner) return out;
    const o: NotifyOwner = {
      id: owner.id,
      displayName: owner.display_name,
      contactRef: owner.contact_ref,
      alertChannels: owner.alert_channels,
    };

    const ref = String(payload.coupleId ?? "");
    const url = payload.matchesUrl ?? (await matchesUrl(env, ownerId));
    const msg: NotifyMessage = kind === "match" ? { ...matchAlertEmail(url), url } : { subject: "Ishtar", text: url, url };

    for (const name of enabledChannels(o)) {
      const channel = getChannel(name);
      if (!channel) continue; // unknown channel name in the CSV → ignore
      out.attempted.push(name);

      // Idempotency claim FIRST: one row per (owner, kind, ref, channel). A second beat loses the claim.
      const claim = await d1
        .prepare(
          "INSERT INTO notifications (owner_id, kind, ref, channel, status) VALUES (?1, ?2, ?3, ?4, 'sent') ON CONFLICT(owner_id, kind, ref, channel) DO NOTHING",
        )
        .bind(ownerId, kind, ref, name)
        .run();
      if (!claim.meta?.changes) {
        out.skipped.push(name); // already handled (replay) → never double-send
        continue;
      }

      // Won the claim. Check readiness, then send. Record the real outcome on the claimed row.
      let status: "sent" | "failed" | "skipped" = "skipped";
      let reason: string | null = null;
      try {
        if (!(await channel.canSend(env, o))) {
          reason = "channel not ready";
        } else {
          const r = await channel.send(env, o, msg);
          if (r.ok) status = "sent";
          else {
            status = "failed";
            reason = r.reason ?? "send failed";
          }
        }
      } catch (e) {
        status = "failed";
        reason = e instanceof Error ? e.message : "send threw";
      }
      await d1
        .prepare("UPDATE notifications SET status = ?1, reason = ?2 WHERE owner_id = ?3 AND kind = ?4 AND ref = ?5 AND channel = ?6")
        .bind(status, reason, ownerId, kind, ref, name)
        .run()
        .catch(() => {});
      if (status === "sent") out.sent.push(name);
      else out.skipped.push(name);
    }
  } catch {
    /* notify is best-effort: never break the caller (matching) over a notify error */
  }
  return out;
}
