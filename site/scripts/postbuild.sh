#!/usr/bin/env bash
# Post-process the Vocs build so the docs live under /docs and a hand-built marketing
# one-pager + dashboard serve at the root. Vocs (basePath=/docs) emits /docs-prefixed links
# and /docs/assets refs but writes files at the output root, so we relocate them under docs/.
# Raw root-served files (ishtar-skill.md, llms*.txt) stay at the root where their absolute
# URLs point. Idempotent; safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."          # → site/
OUT="dist/public"
[ -d "$OUT" ] || { echo "✘ $OUT missing — run 'vocs build' first"; exit 1; }

mkdir -p "$OUT/docs"
# Everything Vocs generates that is /docs-scoped (HTML pages + hashed assets + RSC artifacts).
for f in agents humans legal trust assets RSC _root.d 404.html 404.d index.html sitemap.xml; do
  [ -e "$OUT/$f" ] && mv -f "$OUT/$f" "$OUT/docs/" || true
done
# A root-level 404 so misses outside /docs still render a page.
[ -f "$OUT/docs/404.html" ] && cp -f "$OUT/docs/404.html" "$OUT/404.html" || true
# Marketing root: custom index.html (one-pager) + dashboard/ (live numbers + chatter).
cp -R marketing/. "$OUT/"
echo "✓ postbuild: docs → /docs ; marketing (index + dashboard) at root ; skill/llms kept at root"
