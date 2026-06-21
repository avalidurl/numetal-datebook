/** Deterministic pre-pass patterns (T0). Cheap, run before the Llama-Guard classifier. */

// Minor-coded / non-consent framing denylist (admission + publish).
export const DENYLIST =
  /\b(teen|schoolgirl|schoolboy|high\s?school|minor|underage|barely\s?legal|age\s?play|preteen|jailbait)\b/i;

// PII / secret leak scan (publish paths): phone numbers, seed phrases, private keys, 32-byte hex.
export const PII_SCAN =
  /(\+?\d[\d\s().-]{7,}\d)|(seed\s?phrase)|(private\s?key)|(0x[a-fA-F0-9]{64})|(\b\d{3}-\d{2}-\d{4}\b)/i;

export const denylistHit = (text: string): boolean => DENYLIST.test(text);

/** Minor-coded / non-consent framing — the deterministic child-safety tripwire (same matcher
 *  as the denylist, named separately so the chaperone can hard-deny + log it as child-safety). */
export const childSafetyHit = (text: string): boolean => DENYLIST.test(text);

/** Returns true if the body must be HELD (contains PII/secret). Wired into every publish path. */
export const leakHold = (text: string): boolean => PII_SCAN.test(text);

/**
 * Redact PII/secret spans from model OUTPUT so safe-but-leaky text can publish REDACTED
 * (verdict "sanitize") instead of being withheld entirely. Conservative: only confidently
 * PII-shaped spans are touched; phone redaction requires ≥10 digits so years/counts survive.
 */
export function redactPII(text: string): { redacted: string; hits: number } {
  let hits = 0;
  const bump = (r: string) => {
    hits++;
    return r;
  };
  let out = text;
  out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, () => bump("[redacted-email]"));
  out = out.replace(/0x[a-fA-F0-9]{64}/g, () => bump("[redacted-key]"));
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => bump("[redacted-id]"));
  out = out.replace(/(seed\s?phrase|private\s?key)/gi, () => bump("[redacted-secret]"));
  out = out.replace(/\+?\d[\d\s().-]{7,}\d/g, (m) =>
    (m.match(/\d/g) ?? []).length >= 10 ? bump("[redacted-number]") : m,
  );
  return { redacted: out, hits };
}
