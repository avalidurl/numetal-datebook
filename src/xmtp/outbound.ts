/**
 * Ishtar XMTP — OUTBOUND send path (the one place the venue Worker talks to XMTP for sending).
 *
 * WHY THIS IS HTTP, NOT AN IN-WORKER XMTP CLIENT (deliberate, see src/xmtp/README.md):
 * XMTP identity is a wallet, and sending requires the SIGNER SEED. By design that seed lives ONLY in
 * the listener process (Node), never in any Worker env — so a prompt-injected or compromised brain has
 * no key to leak. The venue therefore SENDS by POSTing the message to the listener's authenticated
 * outbound endpoint; the listener (which holds the signer) creates/loads the DM conversation with the
 * recipient wallet and delivers it. This module is the single, reused wire shape for that POST. We do
 * NOT instantiate a second @xmtp client here (it can't run without the seed, and a second client would
 * fork the inbox state).
 *
 * CONFIG (Worker secrets, all optional → outbound is a safe no-op until set):
 *   XMTP_OUTBOUND_URL    — the listener's send endpoint, e.g. https://xmtp-listener.internal/send
 *   XMTP_OUTBOUND_TOKEN  — optional bearer the listener requires (sent as `Authorization: Bearer …`)
 *
 * The endpoint contract (listener side):
 *   POST <XMTP_OUTBOUND_URL>  { "to": "<0x… recipient wallet>", "text": "<message body>" }
 *   → 2xx on accepted/delivered; non-2xx (or a network error) → we report {ok:false}. Never throws.
 */

/** Minimal slice of Env this module needs — kept local so it doesn't drag the full Env type around. */
export interface XmtpOutboundConfig {
  XMTP_OUTBOUND_URL?: string;
  XMTP_OUTBOUND_TOKEN?: string;
}

/** True only when the outbound path is configured (the listener URL is present). */
export function xmtpConfigured(env: XmtpOutboundConfig): boolean {
  return typeof env.XMTP_OUTBOUND_URL === "string" && /^https?:\/\//i.test(env.XMTP_OUTBOUND_URL.trim());
}

/** A well-formed EVM/XMTP recipient address (0x + 40 hex). XMTP identities are Ethereum addresses. */
export function isXmtpAddress(addr: string | null | undefined): boolean {
  return typeof addr === "string" && /^0x[a-fA-F0-9]{40}$/.test(addr.trim());
}

export interface XmtpSendResult {
  ok: boolean;
  reason?: string;
}

/**
 * Send `text` as an XMTP DM to `to` via the listener's outbound endpoint. Fail-soft: returns
 * {ok:false, reason} for any misconfig/bad-address/transport error and NEVER throws.
 */
export async function sendXmtpDM(env: XmtpOutboundConfig, to: string, text: string): Promise<XmtpSendResult> {
  if (!xmtpConfigured(env)) return { ok: false, reason: "xmtp not configured" };
  const recipient = (to ?? "").trim();
  if (!isXmtpAddress(recipient)) return { ok: false, reason: "no xmtp-reachable wallet" };
  const body = (text ?? "").trim();
  if (!body) return { ok: false, reason: "empty message" };

  const url = env.XMTP_OUTBOUND_URL!.trim();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.XMTP_OUTBOUND_TOKEN) headers.authorization = `Bearer ${env.XMTP_OUTBOUND_TOKEN}`;

  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ to: recipient, text: body }) });
    if (!res.ok) return { ok: false, reason: `xmtp listener ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "xmtp send failed" };
  }
}
