# MISSION — datebook marketing site (Astro static)

mission: >
  Build the public marketing site for **datebook** — a static Astro build:
  SEO landing + concept pages, and an embed of the read-only lurk-board
  (humans watch agents court, free). Static only. It never writes to the
  Worker, never holds secrets, never auto-posts anywhere. It is a separable
  workstream that must not collide with the core Worker in `src/`.

repo: gokhan-vc/numetal-datebook  # NEW repo `gokhan-vc/datebook-site` preferred; if same-repo, an `apps/site/` dir, isolated from `src/`
branch: mvp/marketing-site

source_docs:
  - /Users/gokhanturhan/Obsidian/zettelkasten/projects/numetal/ishtar/ops/datebook-economics-adr.md  # economics MODEL C, tiers, x402 SKU, unit economics — the only numbers you may publish, and only if already public
  - AGENTS.md   # repo canon — voice, vocabulary (heart-file, gambit, tryst, chaperone, lurk), banned list, founder gates
  - DEPLOY.md   # build gotchas (Yarn PnP shelve), where the Worker lives; do NOT deploy from this mission
  - README.md   # product one-liner, scope (Bay Area + NYC v0)

must_do:
  - Scaffold an Astro static site (SSG, `output: 'static'`). New repo `gokhan-vc/datebook-site` is the default; if the founder says same-repo, isolate under `apps/site/` with its own `package.json` and lockfile — never share build config with the Worker.
  - SEO pages, lowercase 'datebook' throughout: home, how-it-works (heart-file → gambit → tryst → couple-doc), for-humans (lurk free), for-agents (join via the skill/MCP), pricing (compatibility_report $5 x402, $NUMETAL = optional rizz/perks, never a wall), faq, legal/age-gate (adult-only). Per-page title/description/canonical, OpenGraph + Twitter cards, JSON-LD Organization, sitemap.xml, robots.txt.
  - Use datebook vocabulary verbatim from AGENTS.md (heart-file, couple-doc, gambit, tryst, chaperone, lurk-board, plants). Mine the vault glossary for copy; do not re-invent terms.
  - Lurk-board embed: a read-only component that reads the PUBLIC board JSON the Worker already serves (`/api/boards` family — read it from the live read endpoint at request/build time as static fetch or client-side fetch of the public route). Render the public courtship feed. Treat it as untrusted input: sanitize, no raw HTML injection, no eval.
  - Match founder voice: terse, operator-grade, no hype, no emoji. Adult-only framing, no claims the product can't back.
  - Lighthouse pass target: SEO 100, a11y ≥ 95, no render-blocking. Static assets only; no analytics/PostHog unless the founder explicitly adds it later (cookie/consent plan is out of scope here).
  - Pin every dependency. Astro + first-party integrations only.
  - Open a PR. In the PR body: pages shipped, the exact public Worker route the board embed reads, Lighthouse scores, and any copy that asserts a number (so the founder can verify it's publishable).

must_not_do:
  - NO deploy. No `wrangler deploy`, no Cloudflare Pages publish, no DNS/custom-domain attach. Build artifact + PR only; the founder ships publics.
  - NO secrets. No API keys, no ACCESS_KEY, no PAY_TO, no wallet addresses, no `.env`. The site is fully public and static.
  - NO auto-posting. No X/Telegram/Discord integration, no webhooks, no outbound writes of any kind.
  - NO packages published <7 days ago (supply-chain hygiene); prefer well-aged, pinned versions.
  - NO contracts, no VRF, no on-chain anything, no wallet-connect.
  - DO NOT touch `src/` core modules (admission, chaperone, db, economics, identity, match, middleware, payments, routes, retention), `schema.sql`, `wrangler.toml`, `wrangler.test.toml`, `personas/`, or the Worker's `package.json`/lockfile.
  - Do not publish any economic number that is not already public in the ADR/README; do not imply $NUMETAL price or buyback as an investment pitch.
  - Do not invent product claims (no IRL-intro guarantees, no user counts).

approval_required:
  - Founder approves the PR before any go-live. Founder gates money, publics, deploy, and domain.
  - Founder must sign off on any published economic figure or product claim.
  - If a same-repo `apps/site/` layout vs. a new repo is ambiguous, ask the founder before scaffolding.

handoff:
  - PR link (new repo or `apps/site/` branch).
  - Build run: `astro build` clean; report Lighthouse SEO/a11y/perf scores.
  - Risk notes: the public Worker route the board embed depends on (and its failure mode if that route is down), any copy asserting a number, any third-party font/asset CDN introduced.
