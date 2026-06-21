# MISSION — extended vitest coverage (test/ only)

mission: >
  Add vitest coverage against the existing harness for the load-bearing
  safety/economics invariants that the current 14 tests don't yet pin:
  courtship-turn idempotency under double-fire, budget governor fail-closed
  → 402, agent-endpoint signature/callback verification, and the retention
  sweeper. Tests ONLY. Do not change behavior in `src/`. If a test reveals a
  real bug, document it in the PR for the founder — do not silently patch core.

repo: gokhan-vc/numetal-datebook
branch: mvp/extended-tests

source_docs:
  - /Users/gokhanturhan/Obsidian/zettelkasten/projects/numetal/ishtar/ops/datebook-economics-adr.md  # MODEL C budget governor (DAILY_BUDGET_USD=5.00, PER_AGENT_DAILY_BUDGET_USD=0.10), fail-closed → BudgetExceeded → 402/cached; inference_costs ledger; tiers
  - AGENTS.md   # canon — idempotent beat, chaperone fail-closed, adult-only, vocabulary
  - DEPLOY.md   # build gotcha: Yarn PnP (~/.pnp.cjs + ~/.pnp.loader.mjs) hijacks esbuild during vitest bundling — shelve (mv aside) for the run, then restore
  - test/payments.test.ts     # existing harness pattern to mirror (cloudflare:test env, env.DB.prepare(...).run() table resets, vitest-pool-workers)
  - test/admission.test.ts    # second pattern reference for D1-backed conditional-update tests
  - src/match/coordinator.ts, src/economics/budget.ts, src/identity/endpoints.ts, src/retention.ts  # read-only: the units under test

must_do:
  - Mirror the existing harness exactly: `import { env } from "cloudflare:test"`, `@cloudflare/vitest-pool-workers`, `vitest.config.ts` + `wrangler.test.toml` as-is, `beforeEach` table resets via `env.DB.prepare("DELETE FROM …").run()`, migrations applied via `test/apply-migrations.ts`. Keep the current 14/14 green; only ADD files/cases.
  - **Courtship-turn idempotency (double-fire):** drive the MatchCoordinator DO beat twice for the same cycle (concurrent + sequential replay). Assert the UNIQUE(cycle_id,a_id,b_id) on couples and UNIQUE(couple_id,turn_seq) on turns hold — exactly one couple, exactly one turn per seq, watermark advances once. Prove the single-threaded mutex makes a re-poke a no-op, not a duplicate beat. The cron `0 * * * *` is a POKE/janitor only — assert a second poke produces no new rows.
  - **Budget fail-closed → 402:** with the daily/per-agent budget exhausted (seed inference_costs or settings so the governor is over cap), assert the governor throws/returns BudgetExceeded and the caller path returns HTTP 402 (or serves cache) — never an uncapped/un-ledgered inference. Cover both DAILY_BUDGET_USD and PER_AGENT_DAILY_BUDGET_USD limits, and that limits read from the D1 `settings` table (runtime override of the env var, no redeploy).
  - **Endpoint signature/callback verification:** exercise `registerEndpoint` → `verifyEndpoint` for BOTH paths — valid signed-nonce activates (active:true, 200), valid callback echoToken activates, and the negatives DENY (wrong/missing signature, wrong echoToken, replayed/stale nonce, unknown endpointId) → active:false / 422. An endpoint must not go active without passing the challenge.
  - **Retention sweeper:** seed expired vs. live rows (trysts/heart-file revisions/whatever `src/retention.ts` governs), run the sweeper, assert expired rows are gone and live rows survive; assert a second sweep is idempotent and that the sweeper is fail-safe (errors don't delete beyond TTL).
  - Tests must be deterministic — no real network, no real x402 facilitator, no live AI Gateway calls; mock providers like `test/payments.test.ts` does. No reliance on wall-clock unless you inject/freeze time.
  - Run the full suite green (old + new) and report the new total count. Open a PR.

must_not_do:
  - DO NOT modify any `src/` core module to make a test pass. Tests adapt to behavior, not the reverse. If a test exposes a real defect (e.g., a beat that double-writes, a budget path that doesn't 402, an endpoint that activates without verifying), leave it as a clearly-marked failing/`.fails` or skipped case WITH a written note and surface it to the founder in the PR — do not patch core in this mission.
  - DO NOT touch `schema.sql`, `src/db/migrations/0000_init.sql`, `wrangler.toml`, or change `wrangler.test.toml`/`vitest.config.ts` semantics (you may read them). Schema changes are out of scope.
  - NO deploy, NO secrets in tests (no real ACCESS_KEY/PAY_TO/wallet keys — use mocks/fixtures), NO live network or real facilitator/gateway calls.
  - NO packages published <7 days ago; reuse the pinned vitest/`@cloudflare/vitest-pool-workers` already in package.json — do not bump them.
  - NO contracts/VRF/on-chain test scaffolding.
  - Do not weaken existing assertions or delete existing tests to get green.

approval_required:
  - Founder approves the PR.
  - If any new test exposes a real safety/economics bug in `src/`, STOP at the test (failing/skipped + note) and flag it — the fix is a separate founder-gated change, not part of this mission.

handoff:
  - PR link (`test/` additions on the branch).
  - Tests run: full `pnpm test` (or `vitest run`) output — old 14 + new, with the new total; note the Yarn-PnP shelve/restore step if you had to apply it.
  - Risk notes: any invariant you could NOT pin from the test seam (and why), any case left skipped/`.fails`, and any real defect surfaced for the founder.
