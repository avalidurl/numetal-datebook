#!/bin/bash
# HTTP fuzzing of the live Worker with schemathesis, driven by fuzz/http/openapi.yaml.
#
# Flow:
#   1. Shelve ~/.pnp.cjs (its presence breaks wrangler's esbuild bundling — see the vault
#      memory "Reef testnet deployment"). Unset NODE_OPTIONS (a --require=...pnp.cjs there
#      does the same). Both are restored on exit.
#   2. Start `wrangler dev` on :8787 in the background; wait until the port answers /health.
#   3. Run schemathesis with all checks against the spec.
#   4. Tear down wrangler dev and restore the environment (trap on EXIT).
#
#   ./fuzz/http/run-schemathesis.sh [max-examples]     # default 40
set -uo pipefail
cd "$(dirname "$0")/../.."

MAX_EXAMPLES="${1:-40}"
PORT=8787
BASE="http://127.0.0.1:${PORT}"
SPEC="fuzz/http/openapi.yaml"
PNP="$HOME/.pnp.cjs"
PNP_SHELVED="$HOME/.pnp.cjs.schemathesis-shelved"
WRANGLER_PID=""

cleanup() {
  # Kill wrangler dev (and any workerd children it spawned).
  if [ -n "$WRANGLER_PID" ] && kill -0 "$WRANGLER_PID" 2>/dev/null; then
    kill "$WRANGLER_PID" 2>/dev/null || true
    wait "$WRANGLER_PID" 2>/dev/null || true
  fi
  pkill -f "wrangler dev" 2>/dev/null || true
  pkill -f "workerd" 2>/dev/null || true
  # Restore pnp shelf.
  if [ -f "$PNP_SHELVED" ] && [ ! -f "$PNP" ]; then
    mv "$PNP_SHELVED" "$PNP"
    echo "restored $PNP"
  fi
}
trap cleanup EXIT INT TERM

# --- 1. shelve pnp + clear NODE_OPTIONS ---------------------------------------------------
unset NODE_OPTIONS
if [ -f "$PNP" ]; then
  mv "$PNP" "$PNP_SHELVED"
  echo "shelved $PNP → $PNP_SHELVED"
fi

# --- ensure schemathesis is available -----------------------------------------------------
if ! command -v schemathesis >/dev/null 2>&1 && ! python3 -c "import schemathesis" >/dev/null 2>&1; then
  echo "schemathesis not found — installing…"
  if command -v pipx >/dev/null 2>&1; then
    pipx install schemathesis || pip3 install --user schemathesis
  else
    pip3 install --user schemathesis
  fi
fi
# Resolve a runnable entrypoint (pipx shim, PATH, or python -m).
if command -v schemathesis >/dev/null 2>&1; then
  ST=(schemathesis)
elif command -v st >/dev/null 2>&1; then
  ST=(st)
else
  ST=(python3 -m schemathesis.cli)
fi

# --- 1b. seed the LOCAL D1 so public reads exercise real handlers, not "no such table" -----
# `wrangler dev --local` starts with an EMPTY D1; without the schema, public reads
# (GET /api/featured, /api/public/*) throw D1_ERROR "no such table" → a 500 that is an
# ENVIRONMENT artifact, not a code bug. Apply the committed migrations first so a 500 in the
# report is a genuine finding.
echo "── applying D1 migrations to the local store ──"
echo "y" | node_modules/.bin/wrangler d1 migrations apply datebook-staging --local >/tmp/wrangler-d1-migrate.log 2>&1 \
  || { echo "!! d1 migrations apply failed — last log lines:"; tail -n 20 /tmp/wrangler-d1-migrate.log; }

# --- 2. start wrangler dev in the background ----------------------------------------------
echo "── starting wrangler dev on :${PORT} ──"
node_modules/.bin/wrangler dev --port "$PORT" --local >/tmp/wrangler-dev-schemathesis.log 2>&1 &
WRANGLER_PID=$!

# Wait up to 90s for /health to answer.
UP=""
for i in $(seq 1 90); do
  if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then
    echo "!! wrangler dev exited early — last log lines:"
    tail -n 40 /tmp/wrangler-dev-schemathesis.log
    exit 1
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/health" 2>/dev/null || true)"
  if [ "$code" != "000" ] && [ -n "$code" ]; then
    UP=1
    echo "wrangler dev is up (GET /health → $code) after ${i}s"
    break
  fi
  sleep 1
done
if [ -z "$UP" ]; then
  echo "!! wrangler dev did not answer on ${BASE}/health within 90s — last log lines:"
  tail -n 40 /tmp/wrangler-dev-schemathesis.log
  exit 1
fi

# --- 3. run schemathesis ------------------------------------------------------------------
# schemathesis 4.x renamed --base-url → --url and --max-examples has a short form -n. The
# older 3.x names are gone. Detect which the installed CLI understands and use it.
if "${ST[@]}" run --help 2>&1 | grep -q -- "--base-url"; then
  URL_FLAG="--base-url"      # schemathesis 3.x
else
  URL_FLAG="--url"          # schemathesis 4.x
fi
echo "── schemathesis run (--checks all, --max-examples ${MAX_EXAMPLES}, ${URL_FLAG} ${BASE}) ──"
"${ST[@]}" run \
  --checks all \
  "$URL_FLAG" "$BASE" \
  --max-examples "$MAX_EXAMPLES" \
  "$SPEC"
ST_EXIT=$?

echo "── schemathesis exit: ${ST_EXIT} ──"
exit "$ST_EXIT"
