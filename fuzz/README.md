# Fuzzing

Two layers (see the strategy note in the vault: `projects/numetal/fuzzing/numetal-ishtar-fuzzing-plan-2026-07-01.md`).

## 1. Property-based (fast-check) — runs in the vitest/miniflare harness
```
pnpm fuzz          # = vitest run test/fuzz
```
Files in `test/fuzz/`:
- `redaction.fuzz.test.ts` — redactPII/PII_SCAN/egressFilter: no-throw, no-ReDoS, idempotent, no PII leak.
- `crypto.fuzz.test.ts` — seal/open + match-token round-trip; tamper → null.
- `payments.fuzz.test.ts` — parsePaymentHeader never-throws; LlamaPay/Didit webhooks fail-closed.
- `egress-secrets.fuzz.test.ts` — every secret shape (sk-/Bearer/AKIA/AIza/gh_/0x{64}/BIP-39 seed) redacted, `safe=false`.
- `safety-detectors.fuzz.test.ts` — detectMinor/detectCrisis/affirms18Plus/looksLikeSystemLeak: no-throw + true-positive anchors.
- `session-nonce.fuzz.test.ts` — nonce single-use; no forged/garbage token resolves to a session.

**Found + fixed day one:** `redactPII` boundary-evasion PII leak (`"1234567890reach me on telegram"` — digits removed the word boundary so `CONTACT` was missed in a single pass) → fixed by running redactPII to a bounded fixed point.

## 2. Coverage-guided (jazzer.js / libFuzzer) — deeper search on pure targets
```
pnpm fuzz:jazzer          # 25s/target
pnpm fuzz:jazzer 120      # longer campaign
```
Targets live in `fuzz/*.fuzz.ts` (bundled to CJS via esbuild first, since jazzer's standalone loader is JS-only). Seeds are committed under `fuzz/seeds/<target>/`; the working corpus (`fuzz/corpus/`) is gitignored and grows across runs. Current target: `redactPII` (idempotence oracle). A crash artifact = a real finding.

## Next (Phase 2/3, per the plan)
jazzer targets for the webhook verifiers; schemathesis HTTP fuzzing vs `wrangler dev`; the agent prompt-injection corpus; CI nightly job with corpus persistence.
