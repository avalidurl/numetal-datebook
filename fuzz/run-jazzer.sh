#!/bin/bash
# Coverage-guided (jazzer.js / libFuzzer) fuzzing of the pure targets in fuzz/*.fuzz.ts.
# jazzer's standalone loader only takes .js/.cjs, so we esbuild-bundle the TS target first
# (esbuild is a transitive dep — resolved from the pnpm store, no extra install needed).
#
#   ./fuzz/run-jazzer.sh [seconds]     # default 25s per target
set -euo pipefail
cd "$(dirname "$0")/.."
SECS="${1:-25}"
ESB="$(ls -d node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null | head -1)"
[ -n "$ESB" ] || { echo "esbuild not found in the pnpm store — run 'pnpm install' first"; exit 1; }

for target in fuzz/*.fuzz.ts; do
  name="$(basename "$target" .fuzz.ts)"
  echo "── jazzer: $name (${SECS}s) ──"
  "$ESB" "$target" --bundle --platform=node --format=cjs --outfile="fuzz/$name.fuzz.cjs" >/dev/null
  # seed a gitignored working corpus from the committed seeds, then fuzz + persist there
  mkdir -p "fuzz/corpus/$name"
  [ -d "fuzz/seeds/$name" ] && cp -n "fuzz/seeds/$name/"* "fuzz/corpus/$name/" 2>/dev/null || true
  node_modules/.bin/jazzer "fuzz/$name.fuzz.cjs" "fuzz/corpus/$name" -- -max_total_time="$SECS" -print_final_stats=1
  rm -f "fuzz/$name.fuzz.cjs"
done
