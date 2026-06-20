# MISSION — dating-doc heart-file intake SKILL + MCP (BYO-creds)

mission: >
  Package datebook's heart-file intake as a **portable SKILL.md + MCP server**
  that any operator copies into THEIR OWN agent and runs with THEIR OWN creds.
  Copy-to-your-agent, bring-your-own-credentials. This is NOT a multi-tenant
  SaaS, NOT a hosted service, NOT a credential-custody product. Each operator
  points it at a datebook base URL + their access key and submits a heart-file /
  registers + verifies their agent endpoint against the existing intake API.

repo: gokhan-vc/numetal-datebook  # ship under `skills/dating-doc/` (SKILL.md + MCP server), isolated from `src/`
branch: mvp/dating-doc-skill

source_docs:
  - /Users/gokhanturhan/Obsidian/zettelkasten/projects/numetal/ishtar/ops/datebook-economics-adr.md  # tiers, x402 SKU, what a heart-file is for, research opt-in semantics
  - AGENTS.md   # canon — heart-file is PRIVATE/never published, gambit/tryst/chaperone vocab, adult-only, no agent-executed money, daters join from any MCP runtime
  - DEPLOY.md   # build gotcha: Yarn PnP (~/.pnp.cjs) hijacks esbuild — shelve then restore for build/test
  - src/routes/intake.ts        # the EXACT endpoints to target — do not modify, just consume
  - src/identity/endpoints.ts   # signed-nonce / callback round-trip contract this skill must satisfy (read-only reference)

target_endpoints:  # consume verbatim, never change server-side
  - POST /api/intake/heart-file   # → { ownerId, heartFileId, tier:"agent_represented" }; body: displayName?, homeMarket, activeMarket, availableFor?, researchOptin(none|aggregate|full), ageAttested, heart{}
  - POST /api/intake/agent        # runtime(openclaw|hermes|claude|codex|other), callbackUrl?, publicKey?, ownerId? → returns endpointId + challenge (signed-nonce OR callback echo)
  - POST /api/intake/agent/verify # endpointId, signature(0x…)? OR echoToken? → { active } (200 active / 422 not)

must_do:
  - Author `skills/dating-doc/SKILL.md` in skill-creator shape: name (lowercase `dating-doc`), one-line purpose, when-to-use triggers, and a BYO-creds setup section (operator supplies `DATEBOOK_BASE_URL` + `DATEBOOK_ACCESS_KEY` as their own env; the skill NEVER ships or stores a key).
  - Build a small MCP server (TypeScript, stdio) exposing tools that map 1:1 to the intake flow: `submit_heart_file`, `register_agent_endpoint`, `verify_agent_endpoint`, and a `check_status` read. Tools call the operator's configured base URL with the operator's access key. Validate inputs with zod mirroring `intake.ts` schemas (do not loosen them).
  - Implement BOTH verification paths the server supports: signed-nonce (sign the challenge nonce with the operator's key → submit `signature`) and callback round-trip (echo the token from the server's callback → submit `echoToken`). Read `src/identity/endpoints.ts` to get the exact challenge/echo contract; satisfy it, do not reinvent it.
  - Enforce the heart-file contract in copy and code: it is PRIVATE, never published; surface `researchOptin` (none/aggregate/full) honestly to the operator; require `ageAttested` (adult-only) before submit.
  - Default network/x402 references to staging (Base Sepolia `eip155:84532`); the skill itself moves no money — it only submits intake. If it mentions the $5 compatibility_report SKU, frame x402 payment as a separate operator-initiated step, never automated by the skill.
  - Ship a README in `skills/dating-doc/` with copy-to-your-agent install steps (OpenClaw, Hermes, Claude/Codex, generic MCP runtime), and a worked example using a throwaway/staging base URL.
  - Self-contained tests for the MCP server against a mock of the three endpoints (request shape, both verify paths, error/422 handling). Use a pinned MCP SDK.
  - Open a PR documenting the skill surface, the BYO-creds model, and that nothing server-side changed.

must_not_do:
  - DO NOT build multi-tenant SaaS, a hosted gateway, credential custody, KYC, billing, or any "we run it for you" framing. It is a skill each operator runs themselves.
  - DO NOT embed, default, or store any credential — no datebook ACCESS_KEY, no PAY_TO, no wallet key, no founder secrets. Creds are the operator's, supplied at their runtime.
  - DO NOT modify the server: no edits to `src/routes/intake.ts`, `src/identity/endpoints.ts`, `src/admission.ts`, `src/db/**`, or any other `src/` core module, `schema.sql`, or `wrangler*.toml`. Consume the API as-is; if it needs a change, freeze and ask the founder.
  - NO deploy, no publishing the MCP to a registry, no auto-posting.
  - NO packages published <7 days ago; pin the MCP SDK and all deps.
  - NO contracts/VRF/on-chain; the skill never sends a transaction or moves funds (agent-executed money is banned).
  - Do not make the skill auto-pay the x402 SKU; payment is a separate, explicit, operator-driven step.

approval_required:
  - Founder approves the PR.
  - Any change that would require a server-side endpoint modification → STOP, freeze scope, ask the founder (do not patch `src/`).
  - Publishing the skill anywhere public (registry, OpenSharing AgentSkill, marketplace) is founder-gated and out of scope for this mission.

handoff:
  - PR link (`skills/dating-doc/` on the branch).
  - Tests run: MCP server suite against the mocked endpoints (both verify paths, 422 cases) — paste the pass/fail line.
  - Risk notes: any field where the skill's zod is stricter/looser than `intake.ts`, the exact challenge/echo contract assumed from `endpoints.ts` (flag if it looked ambiguous), and a reminder that the operator's access key never leaves their runtime.
