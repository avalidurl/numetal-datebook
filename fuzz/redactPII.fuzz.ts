// Coverage-guided (jazzer.js / libFuzzer) target for redactPII. Digs deeper than fast-check's random
// generation by using edge coverage feedback. Oracle = idempotence: redactPII runs to a bounded fixed
// point, so redactPII(x) == redactPII(redactPII(x)). A counterexample means a redaction EXPOSED a new
// PII match on a second pass — the single-pass boundary-evasion leak class the suite already caught once
// ("1234567890reach me on telegram"). If this ever throws, the public board can leak a PII span.
//
// Run: node_modules/.bin/jazzer fuzz/redactPII.fuzz fuzz/corpus/redactPII -- -max_total_time=25
import { redactPII } from "../src/chaperone/patterns";

export function fuzz(data: Buffer): void {
  const s = data.toString("utf-8");
  const once = redactPII(s).redacted;
  const twice = redactPII(once).redacted;
  if (once !== twice) {
    throw new Error(`redactPII NOT idempotent (single-pass PII leak) for input: ${JSON.stringify(s)}`);
  }
}
