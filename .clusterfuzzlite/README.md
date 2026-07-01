# ClusterFuzzLite / OSS-Fuzz build integration (JavaScript / Jazzer.js)

`Dockerfile` + `build.sh` are a valid **OSS-Fuzz build integration** for this repo's Jazzer.js targets:
`build.sh` installs pnpm deps, esbuild-bundles each `fuzz/*.fuzz.ts` target → CJS (`module.exports.fuzz`),
registers it via `compile_javascript_fuzzer`, and ships `fuzz/seeds/<name>/` as its seed corpus.

## ⚠️ The ClusterFuzzLite GitHub Action cannot fuzz JavaScript (as of 2026-07)
The `google/clusterfuzzlite/actions/{build_fuzzers,run_fuzzers}@v1` CIFUZZ path **cannot fuzz a JS project**:
- OSS-Fuzz's `helper.py` auto-sets `SANITIZER=none` for `language: javascript`, and its `SANITIZERS`
  constant includes `none`.
- But **CIFUZZ's `config_utils.py` uses a stricter list** — `['address','memory','undefined','coverage']`,
  **missing `none`** — and does not special-case JS. So: `address`/`memory`/`undefined` are rejected
  (`ERROR: JavaScript projects cannot be fuzzed with sanitizers`), and `none` is rejected by CIFUZZ
  (`Invalid SANITIZER: none`). No `sanitizer` value works → the Action can't run.

**What we run instead:** the coverage-guided Jazzer.js layer runs directly in
`../.github/workflows/fuzz.yml` (`pnpm fuzz:jazzer`, nightly + a growing cached corpus, crash → red build)
— continuous coverage-guided fuzzing in CI, minus ClusterFuzzLite's dashboard/dedup wrapper. Property-based
(fast-check) fuzzing blocks every PR in the same file.

**These files stay** because they *do* work on the full OSS-Fuzz continuous service (which uses `helper.py`,
not CIFUZZ) — relevant if this repo is ever open-sourced + onboarded. For a hosted dashboard on a private
repo, the practical options are commercial (Code Intelligence CI Fuzz — makers of Jazzer.js — or Mayhem).

## Local
`pnpm fuzz:jazzer` runs the same targets via `fuzz/run-jazzer.sh` (esbuild + jazzer).
