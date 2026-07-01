# ClusterFuzzLite

Continuous coverage-guided fuzzing (Jazzer.js) run in GitHub Actions — the observable upgrade to a
hand-rolled nightly jazzer cron. Reuses the same `fuzz/*.fuzz.ts` targets as `pnpm fuzz:jazzer`.

- **`Dockerfile`** — OSS-Fuzz `base-builder-javascript` image + this repo.
- **`build.sh`** — installs pnpm deps, esbuild-bundles each `fuzz/*.fuzz.ts` target → CJS
  (`module.exports.fuzz`), registers it via `compile_javascript_fuzzer`, and ships
  `fuzz/seeds/<name>/` as that fuzzer's seed corpus.
- **`../.github/workflows/cflite_pr.yml`** — on every PR, fuzzes **only the code changed in that PR**
  (`mode: code-change`, 5 min) and **fails the check on a new crash**.
- **`../.github/workflows/cflite_batch.yml`** — nightly (+ manual) 30-min batch campaign over all targets.
- Property-based (fast-check) fuzzing stays in `../.github/workflows/fuzz.yml` (`pnpm fuzz`, blocking).

Current targets: `redactPII`, `parsePaymentHeader`, `llamapay-webhook`. Add a `fuzz/<name>.fuzz.ts`
(+ optional `fuzz/seeds/<name>/`) and it's picked up automatically by both `build.sh` and `pnpm fuzz:jazzer`.

## Corpus & crash storage
Uses the **GitHub Actions cache** by default — works on private repos with no extra setup. For a
persistent/shareable corpus + published HTML coverage reports, add a `storage-repo` (a separate git repo)
and a `PERSONAL_ACCESS_TOKEN` repo secret to the build/run steps (see the ClusterFuzzLite docs) and a
`cflite_cron.yml` with `mode: coverage`. Optional.

## Local equivalent
`pnpm fuzz:jazzer` runs the same targets locally (via `fuzz/run-jazzer.sh`, esbuild + jazzer).
