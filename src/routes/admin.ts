/**
 * Single-pane operator dashboard (the "see everything in one place" view).
 * Access-gated like the rest of the app. GET /admin = HTML; GET /admin.json = raw.
 * Aggregates liveness, capacity, spend vs budget, safety verdicts, revenue, buyback
 * reserve, geo denials, and recent events from D1 — one round of cheap queries.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { utcDay } from "../env";

export const adminRoutes = new Hono<{ Bindings: Env }>();

type Row = Record<string, unknown>;

async function snapshot(env: Env): Promise<Row> {
  const db = env.DB;
  const day = utcDay();
  const first = async (sql: string, ...b: unknown[]): Promise<Row> =>
    ((await db.prepare(sql).bind(...b).first<Row>()) ?? {});
  const list = async (sql: string, ...b: unknown[]): Promise<Row[]> =>
    (await db.prepare(sql).bind(...b).all<Row>()).results ?? [];

  const cap = Number((await first("SELECT value FROM settings WHERE key='admit_cap'")).value ?? env.ADMIT_CAP_DEFAULT);
  const admitted = Number((await first("SELECT count(*) c FROM personas WHERE status='admitted'")).c ?? 0);
  const spendToday = Number((await first("SELECT coalesce(sum(usd),0) s FROM inference_costs WHERE day=?", day)).s ?? 0);
  const budget = Number(env.DAILY_BUDGET_USD);
  const revenue = Number((await first("SELECT coalesce(sum(cast(amount_usdc as real)),0) s FROM payment_receipts")).s ?? 0);
  const reserve = Number((await first("SELECT coalesce(sum(cast(reserve_usdc as real)),0) s FROM buyback_reserve")).s ?? 0);
  const denials = Number((await first("SELECT count(*) c FROM access_denials WHERE date(created_at)=date('now')")).c ?? 0);

  return {
    health: "ok",
    sim_mode: env.SIM_MODE,
    admitted,
    cap,
    cap_used_pct: cap ? Math.round((admitted / cap) * 100) : 0,
    couples_by_state: await list("SELECT state, count(*) n FROM couples GROUP BY state"),
    turns_by_status: await list("SELECT status, count(*) n FROM turns GROUP BY status"),
    spend_today_usd: round(spendToday),
    daily_budget_usd: budget,
    budget_remaining_usd: round(Math.max(0, budget - spendToday)),
    spend_by_model_today: await list("SELECT model, round(sum(usd),5) usd FROM inference_costs WHERE day=? GROUP BY model ORDER BY usd DESC LIMIT 6", day),
    chaperone_today: await list("SELECT verdict, count(*) n FROM chaperone_decisions WHERE date(created_at)=date('now') GROUP BY verdict"),
    orders_by_status: await list("SELECT status, count(*) n FROM premium_orders GROUP BY status"),
    revenue_usdc: round(revenue),
    buyback_reserve_usdc: round(reserve),
    geo_denials_today: denials,
    intros_to_broker: await list(
      "SELECT c.id couple_id, (SELECT contact_ref FROM owners WHERE id=(SELECT owner_id FROM personas WHERE id=c.a_id)) a_contact, (SELECT contact_ref FROM owners WHERE id=(SELECT owner_id FROM personas WHERE id=c.b_id)) b_contact FROM couples c WHERE c.state='committed' ORDER BY c.id DESC LIMIT 25",
    ),
    recent_events: await list("SELECT kind, payload, created_at FROM events ORDER BY id DESC LIMIT 10"),
  };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

adminRoutes.get("/admin.json", async (c) => {
  try {
    return c.json(await snapshot(c.env));
  } catch (e) {
    return c.json({ health: "error", error: String(e) }, 500);
  }
});

adminRoutes.get("/admin", async (c) => {
  let s: Row;
  try {
    s = await snapshot(c.env);
  } catch (e) {
    return c.html(`<h1>datebook ops — DEGRADED</h1><pre>${escapeHtml(String(e))}</pre>`, 500);
  }
  const kv = (rows: Row[], k: string, v: string) =>
    rows.length ? rows.map((r) => `${escapeHtml(String(r[k]))}: <b>${escapeHtml(String(r[v]))}</b>`).join(" · ") : "—";
  const card = (title: string, body: string) =>
    `<div style="border:1px solid #ccc;border-radius:8px;padding:.8rem 1rem;min-width:230px"><div style="opacity:.6;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em">${title}</div><div style="font-size:1.05rem;margin-top:.3rem">${body}</div></div>`;
  const budgetPct = Math.round((Number(s.spend_today_usd) / Number(s.daily_budget_usd || 1)) * 100);

  const html = `<!doctype html><meta charset="utf-8"><title>datebook · ops</title>
<body style="font-family:ui-monospace,monospace;max-width:1000px;margin:1.5rem auto;padding:0 1rem">
<h1 style="font-weight:600">datebook · ops <small style="opacity:.5">${escapeHtml(String(s.sim_mode))} · health: ${s.health}</small></h1>
<div style="display:flex;flex-wrap:wrap;gap:.8rem">
${card("Admitted / cap", `<b>${s.admitted}</b> / ${s.cap} <small style="opacity:.6">(${s.cap_used_pct}%)</small>`)}
${card("Spend today", `$${s.spend_today_usd} / $${s.daily_budget_usd} <small style="opacity:.6">(${budgetPct}%)</small><br><small>left: $${s.budget_remaining_usd}</small>`)}
${card("Revenue (USDC)", `$${s.revenue_usdc}`)}
${card("Buyback reserve", `$${s.buyback_reserve_usdc}`)}
${card("Geo denials today", String(s.geo_denials_today))}
${card("Couples", kv(s.couples_by_state as Row[], "state", "n"))}
${card("Turns", kv(s.turns_by_status as Row[], "status", "n"))}
${card("Chaperone today", kv(s.chaperone_today as Row[], "verdict", "n"))}
${card("Orders", kv(s.orders_by_status as Row[], "status", "n"))}
${card("Spend by model", kv(s.spend_by_model_today as Row[], "model", "usd"))}
${card("Intros to broker", String((s.intros_to_broker as Row[]).length))}
</div>
${(s.intros_to_broker as Row[]).length ? `<h3 style="margin-top:1.4rem">Intros to broker <small style="opacity:.5">(both owners consented — connect them)</small></h3>
<table style="width:100%;border-collapse:collapse;font-size:.85rem">
<tr style="text-align:left;opacity:.6"><th>couple</th><th>contact A</th><th>contact B</th></tr>
${(s.intros_to_broker as Row[]).map((r) => `<tr style="border-top:1px solid #eee"><td>${escapeHtml(String(r.couple_id))}</td><td>${escapeHtml(String(r.a_contact ?? "—"))}</td><td>${escapeHtml(String(r.b_contact ?? "—"))}</td></tr>`).join("")}
</table>` : ""}
<h3 style="margin-top:1.4rem">Recent events</h3>
<table style="width:100%;border-collapse:collapse;font-size:.85rem">
<tr style="text-align:left;opacity:.6"><th>kind</th><th>payload</th><th>at</th></tr>
${(s.recent_events as Row[]).map((e) => `<tr style="border-top:1px solid #eee"><td>${escapeHtml(String(e.kind))}</td><td><code>${escapeHtml(String(e.payload ?? ""))}</code></td><td>${escapeHtml(String(e.created_at))}</td></tr>`).join("")}
</table>
<p style="opacity:.5;margin-top:1rem;font-size:.8rem">raw: <a href="/admin.json?key=${escapeHtml(c.req.query("key") ?? "")}">/admin.json</a> · loop-closure: revenue ${s.revenue_usdc} vs spend ${s.spend_today_usd}/day</p>
</body>`;
  return c.html(html);
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]!);
}
