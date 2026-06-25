/**
 * Ishtar XMTP brain — DETERMINISTIC OUTPUT EGRESS FILTER.
 *
 * This is the structural last line before any text the brain produced leaves over XMTP. It is
 * INDEPENDENT of the model: even a fully prompt-injected model that "decides" to print its system
 * prompt, dump env, or emit a key cannot get that past this — because we scan the OUTPUT and refuse,
 * regardless of what the model chose to say. Llama-Guard is a safety-category filter and is NOT relied
 * on for secret/prompt leakage (red-team gap, 2026-06-25); this is.
 *
 * NB: the primary defense for secrets is that they are never in the model's context at all (see
 * brain.ts — the model only ever sees [system prompt, one untrusted DM]). This filter is the
 * defense-in-depth backstop for the residual "text IS the exfil channel" path.
 */

export interface EgressResult {
  safe: boolean;
  text: string; // the input with any sensitive spans redacted (for logging/audit)
  hits: string[]; // which detectors fired
}

// High-confidence secret shapes. Order doesn't matter; all are applied.
const PATTERNS: { name: string; re: RegExp }[] = [
  // env-style assignment of a secret-named var: OPENAI_API_KEY=…, XMTP_SEED: …, PRIVATE_KEY=…
  { name: "env-secret", re: /\b[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|SEED|PASSWORD|PRIVATE|MNEMONIC|CREDENTIAL)[A-Z0-9_]*\s*[:=]\s*\S+/g },
  // provider API tokens by known prefix
  { name: "api-key", re: /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g },
  // bearer header tokens
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g },
  // JWT
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g },
  // EVM private key / 32-byte hex
  { name: "hex-key", re: /\b0x[a-fA-F0-9]{64}\b/g },
  // bare high-entropy hex blob (keys, hashes, hex seeds) — 40+ hex chars
  { name: "hex-blob", re: /\b[a-fA-F0-9]{40,}\b/g },
  // base64 high-entropy blob (no spaces, 40+ chars) — keys/secrets
  { name: "b64-blob", re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g },
  // BIP-39-shaped seed: a run of 12 or 24 space-separated lowercase words (3–9 chars)
  { name: "seed-phrase", re: /\b(?:[a-z]{3,9}\s+){11}[a-z]{3,9}(?:(?:\s+[a-z]{3,9}){12})?\b/g },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build verbatim system-prompt anchors so a model that regurgitates its instructions is caught.
 * We take distinctive 6+ word fragments from the prompt; a verbatim echo of any is a leak.
 */
export function buildPromptAnchors(systemPrompt: string): string[] {
  return systemPrompt
    .split(/[.\n]/)
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, " "))
    .filter((s) => s.split(" ").length >= 6 && s.length >= 28);
}

/** Scan + redact. safe=false means something sensitive was present (and has been redacted in `text`). */
export function egressFilter(text: string, promptAnchors: string[] = []): EgressResult {
  let out = text ?? "";
  const hits = new Set<string>();
  for (const p of PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags);
    if (re.test(out)) {
      hits.add(p.name);
      out = out.replace(new RegExp(p.re.source, p.re.flags), "[redacted]");
    }
  }
  const low = out.toLowerCase();
  for (const a of promptAnchors) {
    if (a.length >= 28 && low.includes(a)) {
      hits.add("system-prompt-fragment");
      out = out.replace(new RegExp(escapeRe(a), "ig"), "[redacted]");
    }
  }
  return { safe: hits.size === 0, text: out, hits: [...hits] };
}
