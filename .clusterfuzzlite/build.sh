#!/bin/bash -eu
# ClusterFuzzLite build for the Jazzer.js targets in fuzz/*.fuzz.ts.
# The OSS-Fuzz base-builder-javascript image ships Node + npm; this repo uses pnpm.
cd "$SRC/numetal-datebook"
npm install -g pnpm@9
pnpm install --frozen-lockfile || pnpm install

# The jazzer targets are TypeScript. compile_javascript_fuzzer needs JS, so esbuild-bundle each TS target
# into a self-contained CJS module (deps inlined; exposes module.exports.fuzz), then register it as an
# OSS-Fuzz fuzzer. Committed seeds under fuzz/seeds/<name>/ ship as that fuzzer's seed corpus.
ESB="$(ls -d node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | head -1)"
for target in fuzz/*.fuzz.ts; do
  name="$(basename "$target" .fuzz.ts)"
  "$ESB" "$target" --bundle --platform=node --format=cjs --outfile="fuzz/${name}.fuzz.cjs"
  compile_javascript_fuzzer . "fuzz/${name}.fuzz.cjs"
  if [ -d "fuzz/seeds/${name}" ]; then
    (cd "fuzz/seeds/${name}" && zip -q -r "${OUT}/${name}.fuzz_seed_corpus.zip" .)
  fi
done
