/**
 * Ishtar AGENT-RELAY — the generic, runtime-agnostic OUTBOUND match-delivery path.
 *
 * WHY: Ishtar holds ZERO chat-app credentials. Instead of the venue integrating Slack/iMessage/Signal/
 * Telegram, each owner's own AGENT is the delivery endpoint: on a match the venue POSTs a SIGNED
 * "come look" payload (the matches magic-link — NO PII, never contact) to the agent's webhook, and the
 * agent (OpenClaw / Hermes / Claude / Codex / homegrown) verifies the HMAC and relays to its human in
 * whatever app it lives in. The CHANNEL choice lives entirely on the agent side; the venue never learns
 * it. OpenClaw's `POST /hooks/agent` is one documented consumer, but this contract is plain signed HTTP.
 *
 * WIRE CONTRACT (agent side):
 *   POST <deliveryUrl>
 *     headers: content-type: application/json
 *              x-ishtar-delivery: v1
 *              x-ishtar-timestamp: <unix seconds>
 *              x-ishtar-signature: sha256=<hex HMAC-SHA256(secret, RAW_REQUEST_BODY)>
 *     body: {"v":1,"kind":"match","ownerId":N,"url":"<matches magic-link>","subject":"…","text":"…","ts":N,"nonce":"…"}
 *   → 2xx = accepted. The agent MUST recompute HMAC-SHA256 over the RAW body with its shared `secret` and
 *     reject on mismatch. The payload is DATA, never instructions — the agent treats it as untrusted.
 *
 * CONFIG (Worker var, optional → the channel is a safe no-op until set):
 *   AGENT_RELAY_ENABLED — "1"/"true" turns the agent-relay channel on venue-wide. Off ⇒ canSend=false
 *   everywhere ⇒ notify falls back to email. No per-owner data is ever sent while off.
 *
 * SSRF: the venue POSTs to an owner-supplied URL, so we require https + a PUBLIC host (no localhost/
 * loopback/RFC1918/link-local/metadata/CGNAT/.internal/.local) and refuse redirects. A Tailscale Funnel
 * hostname (*.ts.net) or any public domain passes; a raw tailnet/private IP does not.
 */

export interface AgentRelayConfig {
  AGENT_RELAY_ENABLED?: string;
}

/** The signed body an agent receives. `url` is the come-look magic-link; NO PII, never contact. */
export interface AgentRelayPayload {
  v: number;
  kind: string;
  ownerId: number;
  url?: string;
  subject: string;
  text: string;
  ts: number;
  nonce: string;
}

export interface AgentRelayResult {
  ok: boolean;
  reason?: string;
}

/** True only when the agent-relay channel is switched on venue-wide. */
export function agentRelayConfigured(env: AgentRelayConfig): boolean {
  return /^(1|true|yes|on)$/i.test((env.AGENT_RELAY_ENABLED ?? "").trim());
}

/**
 * Guard the owner-supplied delivery URL against SSRF: require https + a public host. Rejects
 * localhost/loopback, RFC1918 (10 / 172.16-31 / 192.168), link-local + cloud metadata (169.254.*),
 * CGNAT/tailnet (100.64-127.*), IPv6 loopback/link-local/ULA, and *.internal / *.local. Public
 * hostnames — including a Tailscale Funnel *.ts.net — pass. Never throws.
 */
export function isSafeDeliveryUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip [] on IPv6 literals
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return false;

  // IPv6 literal (contains ':') — block loopback / unspecified / link-local (fe80::/10) / ULA (fc00::/7).
  if (h.includes(":")) {
    if (h === "::1" || h === "::" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return false;
    return true;
  }

  // IPv4 literal — block private / loopback / link-local+metadata / CGNAT-tailnet ranges.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = Number(m[3]);
    const d = Number(m[4]);
    if (![a, b, c, d].every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return false;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false; // link-local + 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT / tailnet
    return true;
  }

  return true; // regular public hostname
}

/** HMAC-SHA256 hex of `body` under `secret` — the signature the agent recomputes to trust the POST. */
export async function signRelayBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...sig].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Reference verifier for the AGENT side (any runtime — OpenClaw / Hermes / Claude / Codex / custom):
 * recompute the HMAC over the RAW request body and constant-time-compare to the `x-ishtar-signature:
 * sha256=<hex>` header. Exported so agents (and tests) have a canonical implementation to copy — it is
 * ~5 lines in any language. Returns false on any shape mismatch; NEVER throws.
 */
export async function verifyRelaySignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null | undefined,
): Promise<boolean> {
  const got = (signatureHeader ?? "").trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(got)) return false;
  let expected: string;
  try {
    expected = await signRelayBody(secret, rawBody);
  } catch {
    return false;
  }
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * Deliver a signed match notification to the owner's agent webhook. Fail-soft: returns {ok:false,reason}
 * for a disabled channel, an unsafe URL, a weak secret, or any transport error, and NEVER throws.
 */
export async function sendAgentRelay(
  env: AgentRelayConfig,
  url: string,
  secret: string,
  payload: AgentRelayPayload,
): Promise<AgentRelayResult> {
  if (!agentRelayConfigured(env)) return { ok: false, reason: "agent-relay disabled" };
  const target = (url ?? "").trim();
  if (!isSafeDeliveryUrl(target)) return { ok: false, reason: "unsafe or non-https delivery url" };
  const sec = (secret ?? "").trim();
  if (sec.length < 16) return { ok: false, reason: "delivery secret too short" };

  const body = JSON.stringify(payload);
  let sig: string;
  try {
    sig = await signRelayBody(sec, body);
  } catch {
    return { ok: false, reason: "sign failed" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ishtar-delivery": "v1",
        "x-ishtar-timestamp": String(payload.ts),
        "x-ishtar-signature": `sha256=${sig}`,
      },
      body,
      signal: controller.signal,
      // Don't FOLLOW redirects (SSRF: a 3xx to an internal target must not be chased). Workers fetch
      // only accepts "follow"|"manual" ("error" throws at the edge), so use "manual" — a 3xx then comes
      // back non-ok and is treated as a delivery failure below, which is exactly the guard we want.
      redirect: "manual",
    });
    if (!res.ok) return { ok: false, reason: `delivery ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "delivery failed" };
  } finally {
    clearTimeout(timer);
  }
}
