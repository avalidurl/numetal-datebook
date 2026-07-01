/** Deterministic pre-pass patterns (T0). Cheap, run before the Llama-Guard classifier. */

// Minor-coded / non-consent framing denylist (admission + publish).
export const DENYLIST =
  /\b(teen|schoolgirl|schoolboy|high\s?school|minor|underage|barely\s?legal|age\s?play|preteen|jailbait)\b/i;

// Street address (number + street + type). Specific enough to avoid generic numbers.
const STREET =
  /\b\d{1,5}\s+(?:[A-Za-z0-9.'-]+\s+){0,4}(?:street|st|ave|avenue|road|rd|blvd|boulevard|lane|ln|drive|dr|court|ct|way|place|pl|terrace|ter|circle|cir|highway|hwy)\b\.?/i;
// Contact-channel sharing — the pre-reveal exfil vector: a contact URL, or "<my|reach me on>
// <platform>". Deliberately NOT bare "@handle" (those are legit persona refs in the transcript).
const CONTACT =
  /(?:t\.me\/|wa\.me\/|instagram\.com\/|snapchat\.com\/|discord\.gg\/)[\w.+-]+|\b(?:my|reach\s+me\s+(?:on|at|via)|add\s+me\s+on|dm\s+me\s+on|find\s+me\s+on|text\s+me\s+(?:on|at)|i'?m\s+on)\s+(?:telegram|signal|whatsapp|snapchat|wechat|kik|insta(?:gram)?|discord|tg|ig)\b/i;

// PII / secret leak scan (publish paths): phone, seed phrase, private key, 32-byte hex, SSN,
// street address, contact-channel sharing. Used by leakHold → HELD pre-publish (fail-closed).
export const PII_SCAN = new RegExp(
  [
    /(\+?\d[\d\s().-]{7,}\d)/.source,
    /(seed\s?phrase)/.source,
    /(private\s?key)/.source,
    /(0x[a-fA-F0-9]{64})/.source,
    /(\b\d{3}-\d{2}-\d{4}\b)/.source,
    STREET.source,
    CONTACT.source,
  ].join("|"),
  "i",
);

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
  const pass = (s: string): string => {
    let out = s;
    out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, () => bump("[redacted-email]"));
    out = out.replace(/0x[a-fA-F0-9]{64}/g, () => bump("[redacted-key]"));
    out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => bump("[redacted-id]"));
    out = out.replace(/(seed\s?phrase|private\s?key)/gi, () => bump("[redacted-secret]"));
    out = out.replace(new RegExp(STREET.source, "gi"), () => bump("[redacted-address]"));
    out = out.replace(new RegExp(CONTACT.source, "gi"), () => bump("[redacted-contact]"));
    out = out.replace(/\+?\d[\d\s().-]{7,}\d/g, (m) =>
      (m.match(/\d/g) ?? []).length >= 10 ? bump("[redacted-number]") : m,
    );
    return out;
  };
  // SEC-2026-07-01 (FUZZ FINDING): run to a FIXED POINT. A redaction can EXPOSE a new match — e.g.
  // "1234567890reach me on telegram" has NO word boundary before "reach", so CONTACT is missed until the
  // adjacent phone span is redacted (which inserts a boundary). A SINGLE pass leaked the contact-share to
  // the public board. Iterate (bounded, placeholders never re-match) until stable so digit-glued /
  // boundary-evasion PII can't slip past one pass. Also makes redactPII idempotent.
  let out = text;
  for (let i = 0; i < 4; i++) {
    const next = pass(out);
    if (next === out) break;
    out = next;
  }
  return { redacted: out, hits };
}
