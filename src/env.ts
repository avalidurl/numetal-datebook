/** Cloudflare Workers native rate-limiting binding (GA 2025-09). Minimal local shape so
 *  we don't depend on a specific @cloudflare/workers-types version exporting `RateLimit`. */
export interface RateLimit {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

/** Binding + var + secret contract for the datebook Worker. */
export interface Env {
  // bindings
  DB: D1Database;
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  MATCH: DurableObjectNamespace;
  STREAM: DurableObjectNamespace;
  RATE_LIMITER?: RateLimit; // optional — middleware no-ops when unbound (local/test)
  // vars (wrangler.toml [vars])
  SIM_MODE: string;
  BOARD_NAMES: string;
  GUARD_MODEL: string;
  SAFEGUARD_MODEL?: string; // optional gpt-oss-safeguard policy leg (scaffold; off until on Workers AI)
  SAFEGUARD_ENABLED?: string; // "1" to enable the safeguard leg (requires SAFEGUARD_MODEL)
  EMBED_MODEL: string;
  GAMBIT_MODEL: string;
  REPORT_MODEL: string;
  GEO_DENY: string;
  AI_GATEWAY_ID: string;
  ADMIT_CAP_DEFAULT: string;
  DAILY_BUDGET_USD: string;
  PER_AGENT_DAILY_BUDGET_USD: string;
  PER_AGENT_DAILY_T1_BUDGET_USD: string; // per-agent cheap-tier cap (closes the t1 bypass)
  BEAT_MAX_PAIRS: string; // hard cap on couples (and gambits) formed per match beat
  BUYBACK_RESERVE_BPS: string;
  RETENTION_DAYS: string;
  STREAM_CADENCE_SECONDS?: string;
  STREAM_MAX_TURNS?: string;
  STREAM_MIN_TURNS?: string; // min courtship turns before the earned-commitment closure judge runs (default 6)
  STREAM_MIN_COUPLES?: string;
  STREAM_DAILY_BUDGET_USD?: string;
  // Talk-to-Ishtar (paid chat). All optional → sensible defaults in code.
  CHAT_MODEL?: string; // overrides GAMBIT_MODEL for the conversational brain
  TOPIC_MODEL?: string; // small fast model for the intent/scope gate (default @cf/meta/llama-3.2-3b-instruct)
  MODEL_POOL?: string; // P5: comma-separated VERIFIED-LIVE Workers AI ids; each persona courts with its own (empty → single CHAT_MODEL)
  CHAT_CREDITS_PER_USD?: string; // messages bought per $1 USDC top-up (default 25)
  CHAT_LAUNCHED?: string; // "true"/"1" opens Talk to everyone; unset = closed test (whitelist only)
  CHAT_WHITELIST?: string; // comma-separated wallets allowed during the closed test (redacted)
  MIN_DOC_USD?: string; // paid human floor: min USD of $NUMETAL a wallet must hold to submit a dating doc (default 50; "0" disables)
  BASE_RPC_URL?: string; // override the public Base RPC used for the $NUMETAL perk read
  NUMETAL_CA?: string; // override the $NUMETAL contract address
  NUMETAL_PRICE_TTL_MIN?: string; // price-oracle snapshot freshness in minutes (default 60)
  NUMETAL_MIN_LIQ_USD?: string; // drop a price quote whose pool liquidity is below this USD floor (default 500)
  // Cloudflare Access (operator email gate) — vars, not secrets.
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  // secrets (wrangler secret put)
  ACCESS_KEY: string;
  PAY_TO?: string;
  PUBLIC_API_URL?: string; // public origin for x402 `resource` (full URL). Defaults to https://api.ishtar.numetal.xyz
  ENCRYPTION_KEY?: string; // base64 of 32 bytes (AES-256); at-rest encryption is dark until set
  // Newsletter (Resend). All optional → the newsletter is dark (no-op) until set.
  RESEND_API_KEY?: string; // re_… secret; sends from the verified numetal.xyz domain
  RESEND_AUDIENCE_ID?: string; // the Resend audience newsletter subscribers are added to
  NEWSLETTER_FROM?: string; // e.g. "Ishtar <ishtar@numetal.xyz>" (default if unset)
  ALERT_WEBHOOK_URL?: string; // optional Slack-compatible webhook for real-time error alerts
  SENTRY_DSN?: string; // optional — Workers Logs is the default sink; Sentry is extra parity
  // x402 mode: "mainnet" → real USDC via CDP; anything else → Base Sepolia testnet.
  X402_MODE?: string;
  X402_FREE_OWNERS?: string; // comma-separated ownerIds comped past the x402 paywall (e.g. Ishtar + the Intern for the live dating demo)
  EXPERIMENT_ENABLED?: string; // "true"/"1" lights up the Bearer-gated /api/exp/* operator API; OFF by default (routes 404) so the PII-decrypt surface is dormant in normal prod
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  // Escalation tier (humans meet). All optional → the tier is disabled (no-op) until set.
  PRIVY_APP_ID?: string;
  PRIVY_VERIFICATION_KEY?: string; // PEM SPKI public key from the Privy dashboard (ES256)
  DIDIT_API_KEY?: string;
  DIDIT_WORKFLOW_ID?: string;
  DIDIT_WEBHOOK_SECRET?: string;
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** UTC day bucket (YYYY-MM-DD) for budget aggregation. */
export const utcDay = (d = new Date()): string => d.toISOString().slice(0, 10);
