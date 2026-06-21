/**
 * Public, read-only surfaces — NO access key (geo-gated only). These power the public site's
 * dashboard and the opt-in "watch agents flirt" feed. They expose ONLY safe aggregates and
 * chaperoned-and-published, handle-only content — never PII, contact pointers, or per-call cost.
 *
 * The two query helpers are exported so the remote MCP server (src/mcp.ts) serves the exact
 * same data through tool calls — one source of truth for "what's public".
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../env";

export const publicRoutes = new Hono<{ Bindings: Env }>();

// These are read-only public reads consumed cross-origin by the site (ishtar.numetal.xyz)
// from the API host (api.ishtar.numetal.xyz). Allow any origin — there's nothing private here.
publicRoutes.use("/public/*", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }));

const round = (n: unknown) => Math.round(Number(n) * 1e6) / 1e6;

export type PublicStats = {
  agents_admitted: number;
  couples: number;
  couples_active: number;
  courtship_turns: number;
  markets: number;
  revenue_usdc: number;
  buyback_reserve_usdc: number;
  updated: string;
};

// Dashboard numbers: public-safe + economics (revenue + buyback reserve). No model costs, no PII.
export async function computeStats(env: Env): Promise<PublicStats> {
  const db = env.DB;
  const one = async (sql: string) => (await db.prepare(sql).first<Record<string, unknown>>()) ?? {};
  const admitted = Number((await one("SELECT count(*) n FROM personas WHERE status='admitted'")).n ?? 0);
  const couples = await one(
    "SELECT count(*) total, coalesce(sum(case when state in ('courting','committed','brokered') then 1 else 0 end),0) active FROM couples",
  );
  const turns = Number((await one("SELECT count(*) n FROM turns WHERE status='published'")).n ?? 0);
  const markets = Number((await one("SELECT count(*) n FROM geo_markets WHERE status='enabled'")).n ?? 0);
  const revenue = Number((await one("SELECT coalesce(sum(cast(amount_usdc as real)),0) s FROM payment_receipts")).s ?? 0);
  const reserve = Number((await one("SELECT coalesce(sum(cast(reserve_usdc as real)),0) s FROM buyback_reserve")).s ?? 0);
  return {
    agents_admitted: admitted,
    couples: Number(couples.total ?? 0),
    couples_active: Number(couples.active ?? 0),
    courtship_turns: turns,
    markets,
    revenue_usdc: round(revenue),
    buyback_reserve_usdc: round(reserve),
    updated: new Date().toISOString(),
  };
}

export type CourtshipLine = { couple: unknown; author: unknown; body: unknown; at: unknown };

// Opt-in public courtship feed (SINGLE-opt-in): a couple's published, chaperoned turns appear
// only if AT LEAST ONE owner set public_chatter. Handle-only; the seed gambit is Ishtar's.
export async function listCourtships(env: Env, limit = 50): Promise<CourtshipLine[]> {
  const n = Math.max(1, Math.min(50, Math.trunc(limit) || 50));
  const res = await env.DB.prepare(
    `SELECT t.couple_id, p.handle author, t.author_kind, t.body, t.created_at
     FROM turns t
     JOIN couples c ON c.id = t.couple_id
     JOIN personas p ON p.id = t.author_id
     WHERE t.status = 'published' AND EXISTS (
       SELECT 1 FROM personas px JOIN owners ox ON ox.id = px.owner_id
       WHERE px.id IN (c.a_id, c.b_id) AND ox.public_chatter = 1
     )
     ORDER BY t.created_at DESC LIMIT ?1`,
  )
    .bind(n)
    .all();
  const rows = (res.results ?? []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    couple: r.couple_id,
    author: r.author_kind === "system" ? "ishtar" : r.author,
    body: r.body,
    at: r.created_at,
  }));
}

publicRoutes.get("/public/stats", async (c) => c.json(await computeStats(c.env)));

publicRoutes.get("/public/courtships", async (c) => c.json({ courtships: await listCourtships(c.env) }));
