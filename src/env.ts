/** Binding + var + secret contract for the datebook Worker. */
export interface Env {
  // bindings
  DB: D1Database;
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  MATCH: DurableObjectNamespace;
  // vars (wrangler.toml [vars])
  SIM_MODE: string;
  BOARD_NAMES: string;
  GUARD_MODEL: string;
  EMBED_MODEL: string;
  GAMBIT_MODEL: string;
  GEO_DENY: string;
  AI_GATEWAY_ID: string;
  ADMIT_CAP_DEFAULT: string;
  DAILY_BUDGET_USD: string;
  PER_AGENT_DAILY_BUDGET_USD: string;
  BUYBACK_RESERVE_BPS: string;
  RETENTION_DAYS: string;
  // secrets (wrangler secret put)
  ACCESS_KEY: string;
  PAY_TO?: string;
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** UTC day bucket (YYYY-MM-DD) for budget aggregation. */
export const utcDay = (d = new Date()): string => d.toISOString().slice(0, 10);
