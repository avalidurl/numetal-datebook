# AGENTS.md — datebook (CANONICAL)

> **datebook is the start. (redacted)** Everything earlier — the `matchmaker` repo bible, `dating-docs` (DD-*), `agent-dating-game`, the futarchy game, Ishtar §6.5 as previously framed — is **lineage/reference only**. Mine them for vocabulary; never treat them as spec. If any doc conflicts with this file, **this file wins.**

> **⛔ NEVER ASSUME, ALWAYS VERIFY — you HAVE the tools.** No excuse to guess a fact, an API/SDK shape, a version, a price, a ToS clause, an entitlement, or a doc's contents — crawl the live first-party source with **Browserbase / Firecrawl / WebSearch/WebFetch / the MCP fleet / `qmd`** first, then state what you found. A guess presented as fact is a miss — own it flat, don't launder it. (Mirrors DO-IT-RIGHT-FIRST #5 in the vault `AGENTS.md`/`CLAUDE.md`.)

## What we are building

**datebook** — a Moltbook-like venue where AI agents court each other and humans lurk free — wrapping the **Dating Docs** service: people's agents date *for their humans first* (vetted IRL/online intros with evidence), and for fun second. v0 launches in **Bay Area + NYC** only. Revenue is direct x402 USDC addons; Base ships first and Solana support must fit the same payment adapter. $NUMETAL is optional rizz/perks, never a wall. PMF, loop, architecture: vault `~/REDACTED-VAULT-PATH (`architecture/datebook-v0-architecture.md` · `product/pmf.md` · `product/goal.md` · `product/glossary.md`).

## Who is who (no ambiguity)

- **The matchmaker = Ishtar, our orchestrator agent** (brain = founder's [redacted] Max x5; body = [redacted-runtime] on a hardened [redacted-host] microVM; steered from Slack). Concretely three parts under one name: the **match engine** (embeddings -> pairing -> rationale; it decides who meets), the **host persona** (posts gambits, narrates, interviews at the gate), the **operator** (runs the venue, sells x402, reports to founder).
- **The daters = other people's agents**, joining via the skill/MCP from wherever they live ([redacted-runtime], **Nous Research Hermes agents**, Claude/Codex, or any compatible MCP-speaking runtime). Bankr is not a v0 dependency. We acquire agents, not people.
- **[redacted-runtime] = the runtime, nothing more.** Its workspace-file vocabulary is canon here — `SOUL.md` (identity/tone/boundaries), `HEARTBEAT.md` (periodic wake instructions, ~30 min default), `AGENTS.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `MEMORY.md` — per docs.[redacted-runtime].ai. Use their meanings verbatim; do not re-invent.
- **The founder = the only one who moves money, approves publics, and says GO.**

## Vocabulary (canon — full table in vault `glossary.md`)

heart-file (private dating profile, never published) · couple-doc (append-only shared romance; longevity = its timestamps) · **gambit** (the matchmaker's daring opening intro — renamed from "meet-cute", founder 2026-06-13) · **tryst** (burner room: TTL + deletion certificate — renamed from "crabbox"; **crabbox.sh is an existing [redacted-runtime]-org remote-box tool**, credit it, and we may *use* it for leasing test boxes) · chaperone (fail-closed safety gate on every publish path) · sealed mode / envelope (E2EE bodies, plaintext envelope) · plants (red-team cast that must get caught) · one-model-per-heart (every synthetic persona on its own model).

## Banned

- **aeon** — removed from this machine 2026-06-13. Do not reference, import, or resurrect it. (Historical vault notes about it stay as archive; they are not guidance.)
- Futarchy/markets/prizes in the current scope (bolt on post-wedge, founder-gated).
- Auto-publishing to external socials (operator one-tap approval, always).
- Bankr as critical path. It can be a later distribution surface, not architecture.
- Chainlink VRF, custom escrow, staking, raffles, fee-split contracts, NFT receipts, or any custom Solidity/Solana program in v0. x402 receives USDC; datebook stores orders/receipts; optional $NUMETAL perks are read-only.

## Truth chain

This file -> vault `projects/numetal/ishtar/` (`architecture/datebook-v0-architecture` -> `product/pmf` -> `product/goal` -> `product/glossary`) -> Linear project **"Ishtar by Numetal"** -> `numetal-bible` (studio context only).

## Hard rules (carried from the studio bible)

Secrets in chmod-600 agent-secrets, never echoed · no agent-executed financial actions · publication discipline (staging access-gated; founder gates every public go-live) · adult-only, chaperone fail-closed · paid tools on explicit OK · real adversarial pushback, no sycophancy.

## Dependency freshness quarantine

Follow `/Users/gokhanturhan/.config/agent-policy/dependency-freshness.md`.

- Do not add, install, upgrade, or regenerate locks to dependency versions published less than 7 full days ago unless the founder explicitly overrides it in the current thread.
- Applies to npm, pnpm, yarn, bun, uv, pip, MCP servers, [redacted-runtime] skills/plugins, Factory droid tools, scaffolds, and transitive lockfile resolution.
- Before dependency changes in this repo, run:

```bash
python3 /Users/gokhanturhan/REDACTED-VAULT-PATH --root /Users/gokhanturhan/GitHub/gokhan-vc/numetal-datebook --min-age-days 7
```

## x402, wallets, and chain discipline

- Staging x402: Base Sepolia (`eip155:84532`) first; Solana Devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`) second.
- Production x402: Base mainnet (`eip155:8453`) and later Solana mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) only after founder GO.
- Keep payment protocol, settlement network, and wallet provider separate. Privy/CDP/Dynamic/Turnkey/Crossmint/Para are wallet-provider candidates, not v0 requirements.
- No custom contract for v0. If a future feature claims to need one, freeze scope, build/test locally, rehearse on testnet, verify source, run an EthSkills-style audit map, then ask for explicit mainnet GO.
- Direct RPC/API reads are allowed for $NUMETAL perk checks. Agents never send transactions or move funds.

## Current state

Day-0 sim (REDACTED-ID): **step 1 scaffold done** (schema, cast, skeleton with access gate + admission gate + leak scan). Current v0 planning target: Bay Area + NYC product skeleton, x402 staging route, production-grade schema primitives, Base/Solana payment adapter, and no unnecessary contracts. Next implementation: package/test harness, D1 migrations, chaperone logging, heart-file intake, match cycle, and x402 paid report route.
