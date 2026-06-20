# Cloudflare agent setup (Claude Code) — captured 2026-06-21

Source: https://developers.cloudflare.com/agent-setup/claude-code/

datebook is a Cloudflare Workers project, so installing the Cloudflare Skills + MCP
servers gives any coding agent (and Factory droids) live, correct platform context.

## Install (run inside Claude Code, from the repo root where wrangler.toml lives)

```
/plugin marketplace add cloudflare/skills
/plugin install cloudflare@cloudflare
```

This installs the **Cloudflare Skills** bundle and registers the **Cloudflare MCP servers**.
Claude Code CLI install (if needed): `curl -fsSL https://claude.ai/install.sh | bash`.
Verify MCP wiring: `claude mcp list`. First Cloudflare tool call → OAuth authorize (or pass
a Cloudflare API token as a bearer for CI/CD).

## Skills (loaded on demand) — ★ = most relevant to datebook

- ★ **cloudflare** — Workers, Pages, KV/D1/R2, Workers AI/Vectorize/Agents SDK, WAF/DDoS, IaC
- ★ **wrangler** — deploy/dev/manage Workers, D1, R2, Vectorize, Queues, Secrets (correct CLI syntax)
- ★ **workers-best-practices** — streaming, floating promises, global state, secrets, bindings, observability
- ★ **durable-objects** — stateful coordination, RPC, SQLite storage, alarms, WebSockets (our MatchCoordinator)
- ★ **agents-sdk** — Agent class, state, Workflows, queues, retries, observability (for the orchestrator path)
- sandbox-sdk · web-perf · turnstile-spin · cloudflare-email-service · cloudflare-one · cloudflare-one-migrations
- Repo: https://github.com/cloudflare/skills

## MCP servers — ★ = wire these for datebook

| Server | URL |
|---|---|
| ★ Code Mode API (full CF API, ~1K tokens) | `https://mcp.cloudflare.com/mcp` |
| ★ Documentation (current CF docs) | `https://docs.mcp.cloudflare.com/mcp` |
| ★ Workers Bindings (D1/R2/AI/compute) | `https://bindings.mcp.cloudflare.com/mcp` |
| ★ Observability (logs + analytics) | `https://observability.mcp.cloudflare.com/mcp` |
| ★ AI Gateway (prompt/response logs, spend) | `https://ai-gateway.mcp.cloudflare.com/mcp` |
| GraphQL analytics | `https://graphql.mcp.cloudflare.com/mcp` |
| Logpush | `https://logs.mcp.cloudflare.com/mcp` |
| Workers Builds | `https://builds.mcp.cloudflare.com/mcp` |
| Browser rendering | `https://browser.mcp.cloudflare.com/mcp` |
| Audit Logs | `https://auditlogs.mcp.cloudflare.com/mcp` |
| Container | `https://containers.mcp.cloudflare.com/mcp` |
| DNS Analytics | `https://dns-analytics.mcp.cloudflare.com/mcp` |
| CASB / DEX (Cloudflare One) | `https://casb.mcp.cloudflare.com/mcp` · `https://dex.mcp.cloudflare.com/mcp` |

Full catalog: https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/
Repos: https://github.com/cloudflare/mcp-server-cloudflare · https://github.com/cloudflare/mcp (Code Mode)

## Agent-friendly docs (no MCP needed)

- Append **`/index.md`** to any Cloudflare docs URL → clean markdown.
- Per-product index sized for one context window: `developers.cloudflare.com/<product>/llms.txt`
  (e.g. `/workers/llms.txt`, `/agents/llms.txt`, `/d1/llms.txt`, `/workers-ai/llms.txt`).
- Directory of every product: `developers.cloudflare.com/llms.txt`.

## Handy slash commands (after install)

- `/cloudflare:build-agent` — scaffold a full Agents SDK project.
- `/cloudflare:build-mcp` — scaffold a remote MCP server on Workers.

## Model note (Workers AI, verified 2026-06-21)

For Ishtar's orchestrator brain via AI Gateway, prefer **`@cf/nvidia/nemotron-3-120b-a12b`**
($0.50/M in, $1.50/M out — multi-agent-tuned) over **`@cf/moonshotai/kimi-k2.7-code`**
($0.95/M in, $4.00/M out, 1T params, vision) unless you need Kimi's raw ceiling / vision /
cached-input discount. See `projects/numetal/ishtar/ishtar-agent/ishtar-ai-gateway-setup.md`.
