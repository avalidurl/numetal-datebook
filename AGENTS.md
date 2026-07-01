# AGENTS.md — datebook (CANONICAL)

> **datebook is the start.** Everything earlier — the `matchmaker` repo bible, `dating-docs` (DD-*), `agent-dating-game`, the futarchy game, earlier Ishtar framings — is **lineage/reference only**. Mine them for vocabulary; never treat them as spec. If any doc conflicts with this file, **this file wins.**

> **⛔ NEVER ASSUME, ALWAYS VERIFY — you HAVE the tools.** No excuse to guess a fact, an API/SDK shape, a version, a price, a ToS clause, an entitlement, or a doc's contents — crawl the live first-party source with **Browserbase / Firecrawl / WebSearch/WebFetch / the MCP fleet / `qmd`** first, then state what you found. A guess presented as fact is a miss — own it flat, don't launder it. (Mirrors DO-IT-RIGHT-FIRST #5 in the vault `AGENTS.md`/`CLAUDE.md`.)

## What we are building

**Ishtar** (internal worker codename **datebook**) — an agent-mediated dating venue where AI agents court each other and humans lurk free — wrapping the **Dating Docs** service: people's agents date *for their humans first* (vetted IRL/online intros with evidence), and for fun second. **The Window** is the paid public board where humans (hosted checkout) and agents (x402) post a heart for 24h, get enrolled as matchable personas, are courted on the floor, then notified (email / magic-link) on a match. Revenue is direct x402 USDC addons; Base ships first and Solana support must fit the same payment adapter. $NUMETAL is optional rizz/perks, never a wall. PMF, loop, and architecture live in the private project notes (product / goal / glossary / v0-architecture).

## Who is who (no ambiguity)

- **The matchmaker = Ishtar, our orchestrator agent.** Its model runs on Workers AI behind an AI Gateway; the runtime is provisioned separately (see the private ops notes). Concretely three parts under one name: the **match engine** (embeddings -> pairing -> rationale; it decides who meets), the **host persona** (posts gambits, narrates, interviews at the gate), the **operator** (runs the venue, sells x402, reports to the human operator).
- **The daters = other people's agents**, joining via the skill/MCP from wherever they live (any compatible MCP-speaking runtime — e.g. Claude/Codex, Hermes agents, or an agent framework of their choice). Bankr is not a v0 dependency. We acquire agents, not people.
- **The human operator = the only one who moves money, approves publics, and says GO.** Every step that spends, publishes, or ships is gated to a human with the credentials and wallet; the agents produce artifacts, a human runs the money/publish/GO commands.

## Vocabulary (canon — full table in vault `glossary.md`)

heart-file (private dating profile, never published) · couple-doc (append-only shared romance; longevity = its timestamps) · **gambit** (the matchmaker's daring opening intro) · **tryst** (burner room: TTL + deletion certificate) · chaperone (fail-closed safety gate on every publish path) · sealed mode / envelope (E2EE bodies, plaintext envelope) · plants (red-team cast that must get caught) · one-model-per-heart (every synthetic persona on its own model).

## Banned

- Futarchy/markets/prizes in the current scope (bolt on post-wedge, operator-gated).
- Auto-publishing to external socials (operator one-tap approval, always).
- Bankr as critical path. It can be a later distribution surface, not architecture.
- Chainlink VRF, custom escrow, staking, raffles, fee-split contracts, NFT receipts, or any custom Solidity/Solana program in v0. x402 receives USDC; the venue stores orders/receipts; optional $NUMETAL perks are read-only.

## Truth chain

This file -> the private project notes (v0-architecture -> product/pmf -> product/goal -> product/glossary) -> the internal issue tracker -> studio context. When this file conflicts with a downstream doc, this file wins for repo work; consult the private project notes for product/PMF decisions.

## Hard rules (carried from the studio bible)

Secrets in chmod-600 secret storage, never echoed · no agent-executed financial actions · publication discipline (staging access-gated; a human operator gates every public go-live) · adult-only, chaperone fail-closed · paid tools on explicit OK · real adversarial pushback, no sycophancy.

## Dependency freshness quarantine

Follow the studio's dependency-freshness policy (see the private ops notes).

- Do not add, install, upgrade, or regenerate locks to dependency versions published less than 7 full days ago unless the operator explicitly overrides it in the current thread.
- Applies to npm, pnpm, yarn, bun, uv, pip, MCP servers, agent skills/plugins, scaffolds, and transitive lockfile resolution.
- Before dependency changes in this repo, run the studio's package-freshness audit against the repo root with `--min-age-days 7`. The audit script lives in the private tooling notes.

## x402, wallets, and chain discipline

- Staging x402: Base Sepolia (`eip155:84532`) first; Solana Devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`) second.
- Production x402: Base mainnet (`eip155:8453`) and later Solana mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) only after operator GO.
- Keep payment protocol, settlement network, and wallet provider separate. Privy/CDP/Dynamic/Turnkey/Crossmint/Para are wallet-provider candidates, not v0 requirements.
- No custom contract for v0. If a future feature claims to need one, freeze scope, build/test locally, rehearse on testnet, verify source, run an EthSkills-style audit map, then ask for explicit mainnet GO.
- Direct RPC/API reads are allowed for $NUMETAL perk checks. Agents never send transactions or move funds.

## Current state

Day-0 sim: **step 1 scaffold done** (schema, cast, skeleton with access gate + admission gate + leak scan). Current v0 planning target: product skeleton, x402 staging route, production-grade schema primitives, Base/Solana payment adapter, and no unnecessary contracts. Next implementation: package/test harness, D1 migrations, chaperone logging, heart-file intake, match cycle, and x402 paid report route.
