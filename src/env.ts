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
  RATE_LIMITER?: RateLimit; // optional — middleware no-ops when unbound (local/test)
  // vars (wrangler.toml [vars])
  SIM_MODE: string;
  BOARD_NAMES: string;
  GUARD_MODEL: string;
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
  // Cloudflare Access (operator email gate) — vars, not secrets.
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  // secrets (wrangler secret put)
  ACCESS_KEY: string;
  PAY_TO?: string;
  ENCRYPTION_KEY?: string; // base64 of 32 bytes (AES-256); at-rest encryption is dark until set
  SENTRY_DSN?: string; // optional — error capture is a no-op until this is set
  // x402 mode: "mainnet" → real USDC via CDP; anything else → Base Sepolia testnet.
  X402_MODE?: string;
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
