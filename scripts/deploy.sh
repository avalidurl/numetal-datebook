#!/usr/bin/env bash
# Turnkey, idempotent deploy for datebook-staging.
#
# Prereqs you (redacted) provide ONCE:
#   ~/.config/agent-secrets/cloudflare/.env  →  CLOUDFLARE_API_TOKEN with scopes:
#       Workers Scripts:Edit · D1:Edit · Vectorize:Edit · Workers AI:Read · Account Settings:Read
#       (Account Memberships:Read NOT required — we pin CLOUDFLARE_ACCOUNT_ID.)
#   .dev.vars  →  all runtime secrets (ACCESS_KEY, PAY_TO, X402_MODE, DIDIT_*, PRIVY_*, optional SENTRY_DSN)
#
# Then just:  bash scripts/deploy.sh
# Safe to re-run: skips D1/Vectorize creation if they already exist; re-pushes secrets; redeploys.
# Never prints a secret value.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CF_ENV="$HOME/.config/agent-secrets/cloudflare/.env"
DB_NAME="datebook-staging"
VEC_NAME="datebook-hearts"
VEC_DIMS=1024
VEC_METRIC="cosine"

# ---- 0. Auth -------------------------------------------------------------
[ -f "$CF_ENV" ] || { echo "✘ missing $CF_ENV"; exit 1; }
# shellcheck disable=SC1090
set -a; . "$CF_ENV"; set +a
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN not set in cf env}"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID not set in cf env}"
ACC="$CLOUDFLARE_ACCOUNT_ID"
api(){ curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$@"; }

echo "▸ Preflight: verifying token can see D1 + Vectorize on account $ACC …"
d1_ok=$(api "https://api.cloudflare.com/client/v4/accounts/$ACC/d1/database" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("success"))')
vec_ok=$(api "https://api.cloudflare.com/client/v4/accounts/$ACC/vectorize/v2/indexes" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("success"))')
if [ "$d1_ok" != "True" ] || [ "$vec_ok" != "True" ]; then
  echo "✘ Token lacks D1:Edit and/or Vectorize:Edit (D1 ok=$d1_ok, Vectorize ok=$vec_ok)."
  echo "  Create a scoped token at https://dash.cloudflare.com/profile/api-tokens and paste it into:"
  echo "    $CF_ENV   (CLOUDFLARE_API_TOKEN=...)"
  exit 1
fi
echo "  ✓ token has D1 + Vectorize access"

# ---- shelve pnp so wrangler/esbuild bundling isn't hijacked --------------
PNP_C="$HOME/.pnp.cjs"; PNP_L="$HOME/.pnp.loader.mjs"
restore_pnp(){ [ -f "$PNP_C.shelved" ] && mv "$PNP_C.shelved" "$PNP_C" || true; [ -f "$PNP_L.shelved" ] && mv "$PNP_L.shelved" "$PNP_L" || true; }
trap restore_pnp EXIT
[ -f "$PNP_C" ] && mv "$PNP_C" "$PNP_C.shelved" || true
[ -f "$PNP_L" ] && mv "$PNP_L" "$PNP_L.shelved" || true

wr(){ npx --no-install wrangler "$@"; }

# ---- 1. D1 database ------------------------------------------------------
echo "▸ D1: ensuring '$DB_NAME' exists …"
DB_ID=$(api "https://api.cloudflare.com/client/v4/accounts/$ACC/d1/database?name=$DB_NAME" \
  | python3 -c 'import sys,json;r=json.load(sys.stdin).get("result") or [];print(r[0]["uuid"] if r else "")')
if [ -z "$DB_ID" ]; then
  echo "  creating …"
  wr d1 create "$DB_NAME" >/dev/null
  DB_ID=$(api "https://api.cloudflare.com/client/v4/accounts/$ACC/d1/database?name=$DB_NAME" \
    | python3 -c 'import sys,json;r=json.load(sys.stdin).get("result") or [];print(r[0]["uuid"] if r else "")')
fi
[ -n "$DB_ID" ] || { echo "✘ could not resolve D1 database id"; exit 1; }
echo "  ✓ database_id=$DB_ID"

# Write the id into wrangler.toml (idempotent: matches placeholder OR a prior uuid).
python3 - "$DB_ID" <<'PY'
import re, sys
p = "wrangler.toml"; db_id = sys.argv[1]
s = open(p).read()
s = re.sub(r'(database_id\s*=\s*)"[^"]*"', r'\1"%s"' % db_id, s, count=1)
open(p, "w").write(s)
print("  ✓ wrangler.toml database_id set")
PY

# ---- 2. Migrations -------------------------------------------------------
echo "▸ D1: applying migrations (remote) …"
wr d1 migrations apply "$DB_NAME" --remote

# ---- 3. Vectorize index --------------------------------------------------
echo "▸ Vectorize: ensuring '$VEC_NAME' ($VEC_DIMS dims, $VEC_METRIC) …"
vec_exists=$(api "https://api.cloudflare.com/client/v4/accounts/$ACC/vectorize/v2/indexes" \
  | python3 -c "import sys,json;print(any(x.get('name')=='$VEC_NAME' for x in (json.load(sys.stdin).get('result') or [])))")
if [ "$vec_exists" != "True" ]; then
  wr vectorize create "$VEC_NAME" --dimensions="$VEC_DIMS" --metric="$VEC_METRIC"
else
  echo "  ✓ index already exists"
fi

# ---- 4. Deploy (creates the Worker so secrets can attach to it) ----------
echo "▸ Deploying …"
wr deploy

# ---- 5. Secrets (read from .dev.vars; values never printed) --------------
# MUST run after the first deploy: `wrangler secret put` needs the Worker to exist.
# Secrets apply to the live Worker immediately — no redeploy required.
echo "▸ Secrets: pushing from .dev.vars …"
[ -f .dev.vars ] || { echo "✘ .dev.vars missing"; exit 1; }
# Parse .dev.vars robustly WITHOUT sourcing it as shell — a multi-line PEM value (e.g. the
# Privy verification key) would otherwise be executed line-by-line ("PUBLIC: command not found")
# and abort the deploy. This reads `KEY=value`, `KEY="..."`, and quoted multi-line values.
load_var(){
  python3 - "$1" <<'PY'
import sys, re
key = sys.argv[1]
txt = open(".dev.vars").read()
m = re.search(r'(?m)^' + re.escape(key) + r'=(.*)$', txt)
if not m:
    sys.exit(0)
val = m.group(1)
if val[:1] in ('"', "'"):
    q = val[0]
    rest = txt[m.start(1):]
    m2 = re.search(r'(?s)' + q + r'(.*?)(?<!\\)' + q, rest)
    val = m2.group(1) if m2 else val.strip(q)
    val = val.replace('\\n', '\n')
sys.stdout.write(val)
PY
}
push_secret(){
  local name="$1" val
  val="$(load_var "$name")"
  if [ -z "$val" ]; then echo "  – $name: empty, skipped"; return; fi
  printf '%s' "$val" | wr secret put "$name" >/dev/null
  echo "  ✓ $name"
}
for s in ACCESS_KEY PAY_TO X402_MODE DIDIT_API_KEY DIDIT_WORKFLOW_ID DIDIT_WEBHOOK_SECRET PRIVY_APP_ID PRIVY_VERIFICATION_KEY SENTRY_DSN ENCRYPTION_KEY ALERT_WEBHOOK_URL; do
  push_secret "$s"
done

URL="https://${DB_NAME}.cloudflare-ooc0z.workers.dev"
echo
echo "✅ Live: $URL"
echo "   health : $URL/health"
echo "   claim  : $URL/claim?token=<invite>"
echo "   admin  : $URL/admin   (Authorization: Bearer \$ACCESS_KEY)"
echo
echo "Next: set Didit webhook destination → $URL/api/identity/webhook/didit"
