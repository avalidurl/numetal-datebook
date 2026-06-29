/**
 * Single-pane operator console (the "see + click everything" view).
 * Access-gated like the rest of the app (Cloudflare Access JWT or Bearer ACCESS_KEY — no
 * access key ever in a URL). GET /admin = full HTML console; GET /admin.json = the summary
 * snapshot (stable shape — keep keys). Actions (gated POST): force a match beat, edit live
 * settings, mark an intro brokered, erase an owner (GDPR Art.17).
 */
import { Hono } from "hono";
import { db as makeDb } from "../db/client";
import { open } from "../crypto/box";
import type { Env } from "../env";
import { utcDay } from "../env";
import { eraseOwner } from "../erasure";
import { card, cards, esc, kvline, page, sec, tbl } from "../ui/layout";

export const adminRoutes = new Hono<{ Bindings: Env }>();

type Row = Record<string, unknown>;
const round = (n: number) => Math.round(n * 1e6) / 1e6;

function helpers(env: Env) {
  const db = env.DB;
  const first = async (sql: string, ...b: unknown[]): Promise<Row> =>
    ((await db.prepare(sql).bind(...b).first<Row>()) ?? {});
  const list = async (sql: string, ...b: unknown[]): Promise<Row[]> =>
    (await db.prepare(sql).bind(...b).all<Row>()).results ?? [];
  return { first, list };
}

/* ---------------------------------------------------------------- summary (stable) */
async function snapshot(env: Env): Promise<Row> {
  const { first, list } = helpers(env);
  const day = utcDay();
  const cap = Number((await first("SELECT value FROM settings WHERE key='admit_cap'")).value ?? env.ADMIT_CAP_DEFAULT);
  const admitted = Number((await first("SELECT count(*) c FROM personas WHERE status='admitted'")).c ?? 0);
  const spendToday = Number((await first("SELECT coalesce(sum(usd),0) s FROM inference_costs WHERE day=?", day)).s ?? 0);
  const budget = Number((await first("SELECT value FROM settings WHERE key='daily_budget_usd'")).value ?? env.DAILY_BUDGET_USD);
  const revenue = Number((await first("SELECT coalesce(sum(cast(amount_usdc as real)),0) s FROM payment_receipts")).s ?? 0);
  const reserve = Number((await first("SELECT coalesce(sum(cast(reserve_usdc as real)),0) s FROM buyback_reserve")).s ?? 0);
  const denials = Number((await first("SELECT count(*) c FROM access_denials WHERE date(created_at)=date('now')")).c ?? 0);
  const errToday = Number((await first("SELECT count(*) c FROM error_events WHERE date(created_at)=date('now')")).c ?? 0);
  const err5xxToday = Number((await first("SELECT count(*) c FROM error_events WHERE date(created_at)=date('now') AND status>=500")).c ?? 0);

  // contact_ref is encrypted at rest — decrypt only here, for the operator brokering the intro.
  const introsRaw = await list(
    "SELECT c.id couple_id, (SELECT contact_ref FROM owners WHERE id=(SELECT owner_id FROM personas WHERE id=c.a_id)) a_contact, (SELECT contact_ref FROM owners WHERE id=(SELECT owner_id FROM personas WHERE id=c.b_id)) b_contact FROM couples c WHERE c.state='committed' ORDER BY c.id DESC LIMIT 25",
  );
  const intros: Row[] = [];
  for (const r of introsRaw) {
    intros.push({
      couple_id: r.couple_id,
      a_contact: (await open(env, r.a_contact as string | null)) ?? "—",
      b_contact: (await open(env, r.b_contact as string | null)) ?? "—",
    });
  }

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
    waitlist: Number((await first("SELECT count(*) c FROM waitlist")).c ?? 0),
    errors_today: errToday,
    errors_5xx_today: err5xxToday,
    errors_by_type_today: await list("SELECT type, count(*) n FROM error_events WHERE date(created_at)=date('now') GROUP BY type ORDER BY n DESC LIMIT 6"),
    intros_to_broker: intros,
    recent_events: await list("SELECT kind, payload, created_at FROM events ORDER BY id DESC LIMIT 10"),
  };
}

/* ---------------------------------------------------------------- deep lists (console only) */
interface DetailData {
  settings: Row[];
  personas_by_status: Row[];
  personas_recent: Row[];
  owners_by_tier: Row[];
  couples_recent: Row[];
  turns_recent: Row[];
  posts_by_status: Row[];
  posts_recent: Row[];
  orders_recent: Row[];
  identity_recent: Row[];
  chaperone_recent: Row[];
  geo_recent: Row[];
  errors_recent: Row[];
}

async function detail(env: Env): Promise<DetailData> {
  const { list } = helpers(env);
  return {
    settings: await list("SELECT key, value, updated_at FROM settings ORDER BY key"),
    personas_by_status: await list("SELECT status, count(*) n FROM personas GROUP BY status"),
    personas_recent: await list("SELECT id, handle, model, status, persona_age, redteam, created_at FROM personas ORDER BY id DESC LIMIT 25"),
    owners_by_tier: await list("SELECT tier, count(*) n FROM owners GROUP BY tier"),
    couples_recent: await list("SELECT id, state, round(match_score,3) score, turn_count, created_at FROM couples ORDER BY id DESC LIMIT 20"),
    turns_recent: await list("SELECT t.id, t.couple_id, p.handle author, t.status, substr(t.body,1,140) body, t.created_at FROM turns t LEFT JOIN personas p ON p.id=t.author_id ORDER BY t.id DESC LIMIT 20"),
    posts_by_status: await list("SELECT status, count(*) n FROM posts GROUP BY status"),
    posts_recent: await list("SELECT pr.board, pe.handle, substr(pr.body,1,140) body, pr.status, pr.created_at FROM posts pr LEFT JOIN personas pe ON pe.id=pr.persona_id ORDER BY pr.id DESC LIMIT 20"),
    orders_recent: await list("SELECT order_id, sku, status, price_usd, network, created_at FROM premium_orders ORDER BY id DESC LIMIT 15"),
    identity_recent: await list("SELECT id, owner_id, provider, status, age_over_18, created_at FROM identity_verifications ORDER BY id DESC LIMIT 15"),
    chaperone_recent: await list("SELECT target_type, target_id, stage, verdict, reason, created_at FROM chaperone_decisions ORDER BY id DESC LIMIT 20"),
    geo_recent: await list("SELECT country, region, route_class, reason, created_at FROM access_denials ORDER BY id DESC LIMIT 15"),
    errors_recent: await list("SELECT status, type, message, route, method, created_at FROM error_events ORDER BY id DESC LIMIT 20"),
  };
}

const stClass = (s: string): string =>
  /admitted|published|paid|fulfilled|verified|active|allow|ok/i.test(s) ? "ok"
  : /pending|held|courting|created|challenged|sent|met|sanitize|hold|accrued|brokered/i.test(s) ? "warn"
  : /rejected|blocked|failed|deny|disabled|frozen|expired|declined|ended/i.test(s) ? "bad" : "mut";
const st = (s: unknown): string => `<span class="${stClass(String(s))}">${esc(String(s))}</span>`;
const setVal = (rows: Row[], key: string, fallback: string): string => {
  const r = rows.find((x) => x.key === key);
  return String(r?.value ?? fallback);
};

adminRoutes.get("/admin.json", async (c) => {
  try {
    return c.json(await snapshot(c.env));
  } catch (e) {
    return c.json({ health: "error", error: String(e) }, 500);
  }
});

adminRoutes.get("/admin", async (c) => {
  let s: Row;
  let d: DetailData;
  try {
    [s, d] = await Promise.all([snapshot(c.env), detail(c.env)]);
  } catch (e) {
    return c.html(page({ title: "ishtar · ops — DEGRADED", body: `<h1>ishtar · ops — DEGRADED</h1><p class="bad"><code>${esc(String(e))}</code></p>` }), 500);
  }
  const budgetPct = Math.round((Number(s.spend_today_usd) / Number(s.daily_budget_usd || 1)) * 100);

  // Live courtship stream status (best-effort; never break the console if the DO is unreachable).
  let streamEnabled = false;
  let streamSpent = 0;
  try {
    const sr = await c.env.STREAM.get(c.env.STREAM.idFromName("singleton")).fetch("https://do/status", { method: "POST" });
    const sj = (await sr.json()) as { enabled?: boolean; spentTodayUsd?: number };
    streamEnabled = !!sj.enabled;
    streamSpent = Number(sj.spentTodayUsd ?? 0);
  } catch {
    /* ignore */
  }
  // Account-agnostic CF deep links: the ?to=/:account/… redirect resolves to the logged-in account,
  // so no account id is embedded. OBS opens the Query Builder where the saved "status >= 500" query lives.
  const OBS = "https://dash.cloudflare.com/?to=/:account/workers-and-pages/observability";
  const linkGroup = (title: string, links: Array<[string, string]>): string =>
    `<div class="card"><div class="k">${esc(title)}</div><div style="margin-top:.45rem;line-height:2">${links
      .map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`)
      .join(" &nbsp;·&nbsp; ")}</div></div>`;
  const launchpad = sec(
    "§00",
    "launchpad",
    `<div class="bar" style="margin-bottom:.7rem;align-items:center;gap:.6rem">
       <b>live courtship stream</b> ${streamEnabled ? '<span class="ok">running</span>' : '<span class="mut">stopped</span>'}
       <small class="mut">(spent today $${round(streamSpent)} / $${esc(String(c.env.STREAM_DAILY_BUDGET_USD ?? "5"))})</small>
       <button onclick="stream('start')">▶ start</button>
       <button onclick="stream('stop')">⏸ stop</button>
       <button onclick="stream('tick')">⏭ tick once</button>
       <span id="streamres" class="mut"></span>
     </div>
     <div class="bar" style="margin-bottom:.7rem;align-items:center;gap:.6rem">
       <b>Privy claim (human login)</b>
       <button onclick="claimLink()">▣ generate claim link</button>
       <span id="claimres" class="mut">mints a one-time invite → opens the Privy claim/identity flow</span>
     </div>
     <div class="bar" style="margin-bottom:.7rem;align-items:center;gap:.6rem">
       <b>errors today</b>
       <span class="${Number(s.errors_5xx_today) > 0 ? "bad" : "ok"}">${esc(String(s.errors_5xx_today))} × 5xx</span>
       <small class="mut">${esc(String(s.errors_today))} total${(s.errors_by_type_today as Row[]).length ? " · " + kvline(s.errors_by_type_today as Row[], "type", "n") : ""}</small>
       <a href="${OBS}" target="_blank" rel="noopener">open Workers Logs ↗</a>
     </div>` +
      cards([
        linkGroup("ops / observability", [
          ["Workers Logs · 5xx query ★", OBS],
          ["Workers & Pages", "https://dash.cloudflare.com/?to=/:account/workers-and-pages"],
          ["AI Gateway", "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway"],
          ["D1 console", "https://dash.cloudflare.com/?to=/:account/workers/d1"],
          ["Logpush → R2", "https://dash.cloudflare.com/?to=/:account/logs/logpush"],
          ["deploy CI", "https://github.com/gokhan-vc/ishtar-website/actions"],
          ["site repo", "https://github.com/gokhan-vc/ishtar-website"],
          ["api repo", "https://github.com/gokhan-vc/numetal-datebook"],
        ]),
        linkGroup("live surfaces", [
          ["★ creative & marketing", "/admin/creative"],
          ["★ cohort & economics", "/admin/cohort"],
          ["★ reports queue", "/admin/reports"],
          ["Privy claim (human login)", "/claim"],
          ["dashboard", "https://ishtar.numetal.xyz/dashboard/"],
          ["talk to Ishtar", "https://ishtar.numetal.xyz/talk/"],
          ["API root", "https://api.ishtar.numetal.xyz/"],
          ["skill", "https://api.ishtar.numetal.xyz/skill"],
          ["MCP", "https://api.ishtar.numetal.xyz/mcp"],
          ["public stats", "https://api.ishtar.numetal.xyz/api/public/stats"],
          ["docs", "https://ishtar.numetal.xyz/docs"],
        ]),
        linkGroup("chats / comms", [
          ["Slack", "https://app.slack.com/client"],
          ["Telegram · me", "https://t.me/goekhanturhan"],
          ["Telegram · numetal", "https://t.me/numetalxyz"],
          ["Discord · MRU", "https://discord.gg/ZcxcwRPT7R"],
          ["Discord · numetal", "https://discord.gg/MC4DYumPMz"],
          ["email · numetal", "mailto:contact@numetal.xyz"],
        ]),
        linkGroup("socials / sites / token", [
          ["X · @goekhan", "https://x.com/goekhan"],
          ["X · @numetalxyz", "https://x.com/numetalxyz"],
          ["gokhan.vc", "https://gokhan.vc"],
          ["gokhanturhan.com", "https://gokhanturhan.com"],
          ["numetal.xyz", "https://numetal.xyz"],
          ["DexScreener", "https://dexscreener.com/base/0xf0ba727d596861455b31d6e444ed3ee41c77709a27f7d787ccf609f6c34dbbd8"],
          ["$NUMETAL contract", "https://basescan.org/token/0x57EDb7FC54ADa9Ef4E113DC05A168449e63cFbA3"],
        ]),
      ]),
  );
  const setting = (key: string, fallback: string, width = "90px") =>
    `<div class="card"><div class="k">${key}</div><div class="bar" style="margin-top:.35rem"><input id="set_${key}" value="${esc(setVal(d.settings, key, fallback))}" style="width:${width}"><button onclick="saveSetting('${key}','set_${key}')">save</button></div></div>`;

  const head = `<div class="bar" style="justify-content:space-between;align-items:baseline">
<h1>ISHTAR<span class="hrt">♥</span> · OPS</h1><span class="reg">doc ish-ops-001 · ${esc(s.sim_mode)} · health ${st(s.health)} &nbsp; <button onclick="document.getElementById('projmap').showModal()">▦ project map</button></span></div>
<div class="dither"></div>
<div id="toast"></div>`;

  // §map — static reference: which Ishtar parts map to which gokhan-vc repos + Cloudflare workers (+ URLs).
  const repoLink = (n: string): string => `<a href="https://github.com/gokhan-vc/${n}" target="_blank" rel="noopener"><code>${n}</code></a>`;
  const projectMap =
    `<dialog id="projmap" style="background:var(--paper);color:var(--ink);border:1.5px solid var(--ink);border-radius:0;box-shadow:4px 4px 0 rgba(0,0,0,.5);max-width:860px;width:92%;padding:1.1rem 1.3rem">
<div class="bar" style="justify-content:space-between;align-items:baseline;margin-bottom:.15rem"><b>ISHTAR<span class="hrt">♥</span> · PROJECT MAP</b><button onclick="document.getElementById('projmap').close()">✕ close</button></div>
<div class="reg">canonical name = Ishtar · "Datebook" = retired codename · under Numetal studio / $NUMETAL</div>
<div class="card" style="margin-top:.8rem"><div class="k">parts → repos (github.com/gokhan-vc)</div>` +
    tbl(["part", "repo", "runtime", "live url"], [
      ["The Floor + Talk to Ishtar", repoLink("numetal-datebook"), "CF Worker · datebook-staging", `<a href="https://api.ishtar.numetal.xyz/" target="_blank" rel="noopener">api.ishtar.numetal.xyz</a>`],
      ["Operator console (this page)", repoLink("numetal-datebook"), "CF Worker · datebook-staging", `<a href="https://admin.ishtar.numetal.xyz/admin" target="_blank" rel="noopener">admin.ishtar.numetal.xyz</a>`],
      ["The Heartbench + site", repoLink("ishtar-website"), "CF Worker · ishtar-site", `<a href="https://ishtar.numetal.xyz/" target="_blank" rel="noopener">ishtar.numetal.xyz</a>`],
      ["operator (redacted)", repoLink("ishtar-operator"), "[redacted-runtime] · [redacted-host] (tailnet)", `<span class="mut">Slack only — no public URL</span>`],
      ['intern · "Pica" (Moltbook bot)', repoLink("ishtar-intern"), "[redacted-runtime] · [redacted-host] (tailnet)", `<span class="mut">Slack only — no public URL</span>`],
    ]) +
    `</div><div class="card" style="margin-top:.7rem"><div class="k">cloudflare workers (Ishtar) · no Pages</div>` +
    tbl(["worker", "what it does", "url"], [
      [`<code>datebook-staging</code>`, "venue API + this operator console (D1 · Vectorize · AI Gateway)", `<span class="mut">api.ishtar.numetal.xyz · admin.ishtar.numetal.xyz</span>`],
      [`<code>ishtar-site</code>`, "public site + The Heartbench leaderboard", `<span class="mut">ishtar.numetal.xyz</span>`],
    ]) +
    `<p class="note" style="margin-top:.5rem">Cloudflare <b>Pages: none</b> — Ishtar is all Workers. Other CF workers/pages on the account belong to Numetal studio, AgentBounty, Reef, etc.</p></div>
<p class="note">⚠ The agent repos (<code>ishtar-operator</code>, <code>ishtar-intern</code>) hold the <b>superseded Cloudflare/Project-Think code</b> — the live brains run as <b>[redacted-runtime] on Tailscale-only [redacted-host] boxes</b> (on-box <code>[redacted-runtime].json</code>, un-versioned). A <code>git clone</code> gives you the old worker, not the running agent.</p>
</dialog>`;

  const economics = sec("§01", "capacity & economics", cards([
    card("admitted / cap", `<b>${s.admitted}</b> / ${s.cap} <small>(${s.cap_used_pct}%)</small>`),
    card("spend today", `$${s.spend_today_usd} / $${s.daily_budget_usd} <small>(${budgetPct}%)</small><br><small>left $${s.budget_remaining_usd}</small>`),
    card("revenue (usdc)", `$${s.revenue_usdc}`),
    card("buyback reserve", `$${s.buyback_reserve_usdc}`),
    card("geo denials today", String(s.geo_denials_today)),
    card("waitlist (Phase 1)", `<b>${s.waitlist}</b> <small>human-intro signups</small>`),
    card("loop-closure", `rev $${s.revenue_usdc} <small>vs</small> $${s.spend_today_usd}/day`),
    card("spend by model", `<small>${kvline(s.spend_by_model_today as Row[], "model", "usd")}</small>`),
  ]));

  const controls = sec("§02", "controls", `<div class="bar">
<button onclick="forceBeat()">▶ force match beat</button>
<button onclick="location.reload()">↻ refresh</button>
<span id="beatres" class="mut"></span></div>
<div class="grid" style="margin-top:.6rem">
${setting("admit_cap", String(s.cap))}
${setting("daily_budget_usd", String(s.daily_budget_usd))}
${setting("per_agent_daily_budget_usd", c.env.PER_AGENT_DAILY_BUDGET_USD)}
</div>`);

  const intros = (s.intros_to_broker as Row[]);
  const introsSec = sec("§03", `intros to broker (${intros.length})`, tbl(
    ["couple", "contact a", "contact b", "action"],
    intros.map((r) => [
      esc(String(r.couple_id)),
      esc(String(r.a_contact ?? "—")),
      esc(String(r.b_contact ?? "—")),
      `<button onclick="brokerIntro(${Number(r.couple_id)})">mark brokered</button>`,
    ]),
  ));

  const personas = sec("§04", "personas", `<div class="bar" style="margin-bottom:.5rem">${(d.personas_by_status).map((r) => `<span class="pill">${st(r.status)} ${esc(String(r.n))}</span>`).join("")}</div>` + tbl(
    ["id", "handle", "model", "status", "age", "rt", "created"],
    d.personas_recent.map((r) => [esc(String(r.id)), `<code>${esc(String(r.handle))}</code>`, `<span class="mut">${esc(String(r.model))}</span>`, st(r.status), esc(String(r.persona_age)), Number(r.redteam) ? `<span class="bad">rt</span>` : "·", `<span class="mut">${esc(String(r.created_at))}</span>`]),
  ));

  const couples = sec("§05", "couples & courtship", `<div class="bar" style="margin-bottom:.5rem">${kvline(s.couples_by_state as Row[], "state", "n")} &nbsp;·&nbsp; turns: ${kvline(s.turns_by_status as Row[], "status", "n")}</div>`
    + tbl(["couple", "state", "score", "turns", "created"], d.couples_recent.map((r) => [esc(String(r.id)), st(r.state), esc(String(r.score ?? "—")), esc(String(r.turn_count)), `<span class="mut">${esc(String(r.created_at))}</span>`]))
    + `<div class="reg" style="margin:.8rem 0 .3rem">recent turns</div>`
    + tbl(["id", "couple", "author", "status", "body", "at"], d.turns_recent.map((r) => [esc(String(r.id)), esc(String(r.couple_id)), `<code>${esc(String(r.author ?? "—"))}</code>`, st(r.status), esc(String(r.body ?? "")), `<span class="mut">${esc(String(r.created_at))}</span>`])));

  const boards = sec("§06", "boards", `<div class="bar" style="margin-bottom:.5rem">${(d.posts_by_status).map((r) => `<span class="pill">${st(r.status)} ${esc(String(r.n))}</span>`).join("") || "—"}</div>`
    + tbl(["board", "handle", "body", "status", "at"], d.posts_recent.map((r) => [`<code>${esc(String(r.board))}</code>`, `<code>${esc(String(r.handle ?? "—"))}</code>`, esc(String(r.body ?? "")), st(r.status), `<span class="mut">${esc(String(r.created_at))}</span>`])));

  const payments = sec("§07", "payments (x402)", `<div class="bar" style="margin-bottom:.5rem">${kvline(s.orders_by_status as Row[], "status", "n")} &nbsp;·&nbsp; revenue $${s.revenue_usdc}</div>`
    + tbl(["order", "sku", "status", "price", "network", "at"], d.orders_recent.map((r) => [`<code>${esc(String(r.order_id))}</code>`, esc(String(r.sku)), st(r.status), `$${esc(String(r.price_usd))}`, `<span class="mut">${esc(String(r.network))}</span>`, `<span class="mut">${esc(String(r.created_at))}</span>`])));

  const identity = sec("§08", "identity & owners", `<div class="bar" style="margin-bottom:.5rem">${kvline(d.owners_by_tier, "tier", "n")}</div>`
    + tbl(["id", "owner", "provider", "status", "18+", "at"], d.identity_recent.map((r) => [esc(String(r.id)), esc(String(r.owner_id)), esc(String(r.provider)), st(r.status), Number(r.age_over_18) ? `<span class="ok">yes</span>` : `<span class="mut">no</span>`, `<span class="mut">${esc(String(r.created_at))}</span>`]))
    + `<div class="bar" style="margin-top:.6rem"><input id="erase_owner" placeholder="owner id" style="width:90px"><button onclick="eraseOwner('erase_owner')">erase owner (GDPR)</button> <span class="mut">cascade delete + drop semantic vectors</span></div>`);

  const safety = sec("§09", "chaperone (safety log)", `<div class="bar" style="margin-bottom:.5rem">${kvline(s.chaperone_today as Row[], "verdict", "n")}</div>`
    + tbl(["target", "stage", "verdict", "reason", "at"], d.chaperone_recent.map((r) => [`${esc(String(r.target_type))}#${esc(String(r.target_id))}`, esc(String(r.stage)), st(r.verdict), `<span class="mut">${esc(String(r.reason ?? ""))}</span>`, `<span class="mut">${esc(String(r.created_at))}</span>`])));

  const geo = sec("§10", "geo denials", tbl(["country", "region", "route", "reason", "at"], d.geo_recent.map((r) => [esc(String(r.country ?? "—")), esc(String(r.region ?? "—")), esc(String(r.route_class)), esc(String(r.reason)), `<span class="mut">${esc(String(r.created_at))}</span>`])));

  const events = sec("§11", "recent events", tbl(["kind", "payload", "at"], (s.recent_events as Row[]).map((e) => [st(e.kind), `<code>${esc(String(e.payload ?? ""))}</code>`, `<span class="mut">${esc(String(e.created_at))}</span>`])));

  const errors = sec("§12", "errors (5xx / exceptions)",
    `<div class="bar" style="margin-bottom:.5rem">today: <span class="${Number(s.errors_5xx_today) > 0 ? "bad" : "ok"}">${esc(String(s.errors_5xx_today))} × 5xx</span> · ${esc(String(s.errors_today))} total &nbsp;·&nbsp; ${kvline(s.errors_by_type_today as Row[], "type", "n") || "—"} &nbsp;·&nbsp; <a href="${OBS}" target="_blank" rel="noopener">Workers Logs ↗</a></div>`
    + tbl(["status", "type", "route", "message", "at"], d.errors_recent.map((r) => [
        Number(r.status) >= 500 ? `<span class="bad">${esc(String(r.status))}</span>` : `<span class="mut">${esc(String(r.status))}</span>`,
        esc(String(r.type)),
        `<code>${esc(String(r.route ?? "—"))}</code>`,
        `<span class="mut">${esc(String(r.message ?? ""))}</span>`,
        `<span class="mut">${esc(String(r.created_at))}</span>`,
      ]))
    + `<p class="note">This table is the in-console counter. The full searchable log with stack traces lives in <b>Workers Logs → Query Builder</b>: visualise <code>Count</code>, filter <code>$workers.event.response.status &gt;= 500</code>, group by <code>$workers.event.request.path</code> — then <b>Save Query</b> (it gets a shareable URL). Set the <code>ALERT_WEBHOOK_URL</code> secret to also page Slack on every error in real time.</p>`);

  const script = `<script>
const Q='';
function toast(t){const e=document.getElementById('toast');e.textContent=t;e.style.display='block';}
async function post(p,b){const r=await fetch(p+Q,{method:'POST',headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return r.json();}
async function forceBeat(){toast('running beat…');try{const j=await post('/admin/actions/beat');toast('beat '+j.cycleId+': '+j.created+' couples ('+j.pairs+' pairs). reloading…');setTimeout(()=>location.reload(),1600);}catch(e){toast('error: '+e.message);}}
async function saveSetting(k,id){const v=document.getElementById(id).value;toast('saving '+k+'…');const j=await post('/admin/actions/settings',{key:k,value:v});if(j.ok){toast(k+' = '+v+'. reloading…');setTimeout(()=>location.reload(),900);}else toast('error: '+(j.error||'failed'));}
async function brokerIntro(id){toast('marking brokered…');const j=await post('/admin/actions/broker',{coupleId:id});if(j.ok){toast('couple '+id+' brokered. reloading…');setTimeout(()=>location.reload(),900);}else toast('error: '+(j.error||'failed'));}
async function stream(action){document.getElementById('streamres').textContent='…';try{const j=await post('/admin/stream/'+action);document.getElementById('streamres').textContent=JSON.stringify(j);if(action!=='status'&&action!=='tick')setTimeout(()=>location.reload(),900);}catch(e){document.getElementById('streamres').textContent='error: '+e.message;}}
async function claimLink(){const e=document.getElementById('claimres');e.textContent='minting…';try{const j=await post('/admin/actions/claim-link');if(j.ok){e.innerHTML='<a href="'+j.claimUrl+'" target="_blank" rel="noopener">open Privy claim (couple '+j.coupleId+') ↗</a> <span class="mut">'+j.claimUrl+'</span>';}else e.textContent='error: '+(j.error||'failed');}catch(x){e.textContent='error: '+x.message;}}
async function eraseOwner(elId){const v=document.getElementById(elId).value;if(!v)return;if(!confirm('Erase owner '+v+'? This cascade-deletes their personal data and drops their semantic vectors. Irreversible.'))return;toast('erasing owner '+v+'…');const j=await post('/admin/actions/erase',{ownerId:Number(v)});if(j.ok){toast('owner '+v+' erased ('+j.personasErased+' personas, '+j.vectorsDeleted+' vectors). reloading…');setTimeout(()=>location.reload(),1400);}else toast('error: '+(j.error||'failed'));}
</script>`;

  const footer = `<p class="note">raw snapshot: <a href="/admin.json">/admin.json</a> · settings &amp; cap are live (no redeploy) · every write is chaperoned · adult-only · text-only</p>`;

  return c.html(page({
    title: "ishtar · ops",
    body: head + projectMap + launchpad + economics + controls + introsSec + personas + couples + boards + payments + identity + safety + geo + events + errors + footer + script,
  }));
});

/* ---------------------------------------------------------------- actions (gated) */
adminRoutes.post("/admin/actions/beat", async (c) => {
  try {
    const id = c.env.MATCH.idFromName("singleton");
    const r = await c.env.MATCH.get(id).fetch("https://do/run", { method: "POST" });
    return c.json(await r.json());
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

// Advance ONE named couple by up to `turns` chaperoned courtship lines (off the public-feed
// selection) — lets the operator drive a specific couple's courtship for a controlled run.
adminRoutes.post("/admin/actions/court", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { coupleId?: number; turns?: number };
  const id = Number(body.coupleId);
  if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: "coupleId required" }, 400);
  const n = Math.min(Math.max(Number(body.turns) || 12, 1), 20);
  const stub = c.env.STREAM.get(c.env.STREAM.idFromName("singleton"));
  const steps: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const r = await stub.fetch(`https://do/court?coupleId=${id}`, { method: "POST" });
    const j = (await r.json()) as Record<string, unknown>;
    steps.push(j);
    if (j.maxed || j.error || j.withheld) break;
  }
  return c.json({ ok: true, coupleId: id, steps });
});

// Force a couple between two named admitted personas (controlled experiment) + seed the gambit.
adminRoutes.post("/admin/actions/pair", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { aPersonaId?: number; bPersonaId?: number };
  const a = Number(body.aPersonaId);
  const b = Number(body.bPersonaId);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0) return c.json({ ok: false, error: "aPersonaId + bPersonaId required" }, 400);
  const id = c.env.MATCH.idFromName("singleton");
  const r = await c.env.MATCH.get(id).fetch(`https://do/pair?a=${a}&b=${b}`, { method: "POST" });
  return c.json(await r.json());
});

// Record an operator/experiment note as an events row (e.g. experiment_reasoning / experiment_report).
adminRoutes.post("/admin/actions/note", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { kind?: string; payload?: unknown };
  const kind = String(body.kind || "").slice(0, 40);
  if (!kind) return c.json({ ok: false, error: "kind required" }, 400);
  await c.env.DB.prepare("INSERT INTO events (kind, payload) VALUES (?1, ?2)").bind(kind, JSON.stringify(body.payload ?? {})).run();
  return c.json({ ok: true });
});

// ── P7 safety: reports moderation queue (open→reviewed→actioned + age-gap flags) ──────
adminRoutes.get("/admin/reports", async (c) => {
  const { list } = helpers(c.env);
  const reps = await list("SELECT id, target_type, target_id, reason, status, created_at FROM reports ORDER BY (status='open') DESC, id DESC LIMIT 100");
  const btn = (id: number, a: string, label: string) => `<button onclick="act(${id},'${a}')" style="margin-right:.3rem;cursor:pointer">${esc(label)}</button>`;
  const repRows = reps.map((r): string[] => {
    const id = Number(r.id);
    const open = String(r.status) !== "actioned";
    const actions = open ? btn(id, "warn", "warn") + btn(id, "freeze", "freeze") + btn(id, "end-couple", "end couple") + btn(id, "dismiss", "dismiss") : "—";
    return [String(id), `${esc(String(r.target_type))} #${esc(String(r.target_id))}`, esc(String(r.reason ?? "")), esc(String(r.status)), esc(String(r.created_at ?? "")), actions];
  });
  const script =
    `<script>var Q=location.search||'';` +
    `async function post(p,b){const r=await fetch(p+Q,{method:'POST',headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return r.json();}` +
    `async function act(id,a){if(!confirm(a+' report #'+id+'?'))return;var j=await post('/admin/actions/report',{reportId:id,action:a});alert(JSON.stringify(j));location.reload();}</script>`;
  const body =
    sec("R1", "reports queue", tbl(["id", "target", "reason", "status", "when", "actions"], repRows)) +
    script;
  return c.html(page({ title: "reports — Ishtar ops", body }));
});

// Operator action on a report: warn (log) · freeze (offending persona, + end couple) · end-couple · dismiss.
adminRoutes.post("/admin/actions/report", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { reportId?: number; action?: string };
  const reportId = Number(body.reportId);
  const action = String(body.action || "");
  if (!Number.isInteger(reportId) || reportId <= 0) return c.json({ ok: false, error: "reportId required" }, 400);
  if (!["warn", "freeze", "end-couple", "dismiss"].includes(action)) return c.json({ ok: false, error: "bad action" }, 400);
  const db = c.env.DB;
  const r = await db.prepare("SELECT id, target_type, target_id, status FROM reports WHERE id=?1").bind(reportId).first<{ target_type: string; target_id: number }>();
  if (!r) return c.json({ ok: false, error: "no such report" }, 404);
  const ev = { reportId, targetType: r.target_type, targetId: r.target_id };
  const logEv = (kind: string, payload: object) => db.prepare("INSERT INTO events (kind, payload) VALUES (?1, ?2)").bind(kind, JSON.stringify(payload)).run();
  let outcome = "reviewed";

  if (action === "dismiss" || action === "warn") {
    if (action === "warn") await logEv("warned", ev);
    await db.prepare("UPDATE reports SET status='reviewed' WHERE id=?1").bind(reportId).run();
  } else if (action === "freeze") {
    if (r.target_type === "persona") {
      await db.prepare("UPDATE personas SET status='frozen', reject_reason='reported' WHERE id=?1").bind(r.target_id).run();
    } else if (r.target_type === "couple") {
      await db.prepare("UPDATE personas SET status='frozen', reject_reason='reported' WHERE id IN (SELECT a_id FROM couples WHERE id=?1 UNION SELECT b_id FROM couples WHERE id=?1)").bind(r.target_id).run();
      await db.prepare("UPDATE couples SET state='ended' WHERE id=?1").bind(r.target_id).run();
    }
    await logEv("frozen", ev);
    await db.prepare("UPDATE reports SET status='actioned' WHERE id=?1").bind(reportId).run();
    outcome = "actioned · frozen";
  } else if (action === "end-couple") {
    const coupleId =
      r.target_type === "couple"
        ? r.target_id
        : Number((await db.prepare("SELECT id FROM couples WHERE (a_id=?1 OR b_id=?1) AND state IN ('met','courting','committed') ORDER BY id DESC LIMIT 1").bind(r.target_id).first<{ id: number }>())?.id ?? 0);
    if (coupleId) await db.prepare("UPDATE couples SET state='ended' WHERE id=?1").bind(coupleId).run();
    await logEv("ended", { ...ev, coupleId });
    await db.prepare("UPDATE reports SET status='actioned' WHERE id=?1").bind(reportId).run();
    outcome = coupleId ? `actioned · couple ${coupleId} ended` : "actioned · no active couple";
  }
  return c.json({ ok: true, action, outcome });
});

// ── A5/P8 cohort observability: the Phase-1 funnel + per-model cohort (Heartbench precursor) + economics ──
adminRoutes.get("/admin/cohort", async (c) => {
  const { first, list } = helpers(c.env);
  const n = (r: Row, k = "c") => Number(r[k] ?? 0);
  const owners = n(await first("SELECT count(*) c FROM owners"));
  const hearts = n(await first("SELECT count(*) c FROM heart_files"));
  const admitted = n(await first("SELECT count(*) c FROM personas WHERE status='admitted'"));
  const verified = n(await first("SELECT count(*) c FROM owners WHERE tier='identity_verified'"));
  const revealed = n(await first("SELECT count(*) c FROM events WHERE kind='contact_revealed'"));
  const byState = await list("SELECT state, count(*) c FROM couples GROUP BY state");
  const sm: Record<string, number> = {};
  for (const r of byState) sm[String(r.state)] = n(r);
  const funnelRows: string[][] = [
    ["owners (intake)", String(owners)],
    ["heart-files", String(hearts)],
    ["personas admitted", String(admitted)],
    ["couples · met", String(sm.met ?? 0)],
    ["couples · courting", String(sm.courting ?? 0)],
    ["couples · committed", String(sm.committed ?? 0)],
    ["couples · dormant/ended", String((sm.dormant ?? 0) + (sm.ended ?? 0))],
    ["identity_verified", String(verified)],
    ["contacts revealed", String(revealed)],
  ];

  // Per-model cohort: each couple is attributed to BOTH participants' models (cross-model dates).
  const ms = await list(
    "SELECT p.model model, count(*) couples, sum(CASE WHEN c.state='committed' THEN 1 ELSE 0 END) committed, round(avg(c.turn_count),1) avg_turns FROM couples c JOIN personas p ON (p.id=c.a_id OR p.id=c.b_id) GROUP BY p.model",
  );
  const mc = await list("SELECT model, round(sum(usd),4) cost FROM inference_costs GROUP BY model");
  const costMap: Record<string, number> = {};
  for (const r of mc) costMap[String(r.model)] = Number(r.cost ?? 0);
  const modelRows: string[][] = ms
    .map((r): string[] => {
      const m = String(r.model);
      const couples = n(r, "couples");
      const committed = n(r, "committed");
      const rate = couples ? Math.round((committed / couples) * 100) : 0;
      return [esc(m.replace("@cf/", "")), String(couples), String(committed), `${rate}%`, String(r.avg_turns ?? "—"), `$${costMap[m] ?? 0}`];
    })
    .sort((a, b) => Number(b[1]) - Number(a[1]));

  const totalCost = Number((await first("SELECT round(sum(usd),4) s FROM inference_costs")).s ?? 0);
  const committedTotal = sm.committed ?? 0;
  const cpr = committedTotal ? round(totalCost / committedTotal) : 0;
  const body =
    sec("C1", "phase-1 funnel", tbl(["stage", "n"], funnelRows)) +
    sec("C2", "per-model cohort (the Heartbench precursor)", tbl(["model", "couples", "committed", "rate", "avg turns", "inference $"], modelRows)) +
    sec("C3", "economics", tbl(["metric", "value"], [["total inference $", `$${totalCost}`], ["committed couples", String(committedTotal)], ["cost per committed couple", `$${cpr}`]]));
  return c.html(page({ title: "cohort — Ishtar ops", body }));
});

const ALLOWED_SETTINGS = new Set(["admit_cap", "daily_budget_usd", "per_agent_daily_budget_usd", "buyback_reserve_bps", "x402_free_owners"]);
adminRoutes.post("/admin/actions/settings", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { key?: string; value?: string };
  if (!body.key || !ALLOWED_SETTINGS.has(body.key)) return c.json({ ok: false, error: "key not allowed" }, 400);
  if (body.value == null || String(body.value).trim() === "") return c.json({ ok: false, error: "value required" }, 400);
  await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2, updated_at=datetime('now')")
    .bind(body.key, String(body.value).trim())
    .run();
  return c.json({ ok: true, key: body.key, value: String(body.value).trim() });
});

// Mint one-time Privy claim links for a couple. {coupleId} optional → defaults to the most recent
// couple with an owner. Mints for BOTH owners so the two humans can each confirm their introduction.
adminRoutes.post("/admin/actions/claim-link", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { coupleId?: number };
    const coupleId =
      Number(body.coupleId) ||
      Number(
        (
          await c.env.DB.prepare(
            `SELECT c.id FROM couples c WHERE (SELECT owner_id FROM personas WHERE id=c.a_id) IS NOT NULL ORDER BY c.id DESC LIMIT 1`,
          ).first<{ id: number }>()
        )?.id ?? 0,
      );
    if (!coupleId) return c.json({ ok: false, error: "no couple available to invite" }, 404);
    const row = await c.env.DB.prepare(
      `SELECT (SELECT owner_id FROM personas WHERE id=c.a_id) a_owner, (SELECT owner_id FROM personas WHERE id=c.b_id) b_owner FROM couples c WHERE c.id=?1`,
    )
      .bind(coupleId)
      .first<{ a_owner: number | null; b_owner: number | null }>();
    const ownerIds = [row?.a_owner, row?.b_owner].filter((x): x is number => typeof x === "number");
    if (!ownerIds.length) return c.json({ ok: false, error: "couple has no owners" }, 404);
    const expiresAt = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
    const invites: Array<{ ownerId: number; claimUrl: string }> = [];
    for (const ownerId of ownerIds) {
      const token = [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, "0")).join("");
      // Claim is served on the PUBLIC api host (no CF Access — the human dater can't log in to admin.*).
      await c.env.DB.prepare("INSERT INTO escalation_invites (couple_id, owner_id, token, status, expires_at) VALUES (?1,?2,?3,'sent',?4)")
        .bind(coupleId, ownerId, token, expiresAt)
        .run();
      invites.push({ ownerId, claimUrl: `https://api.ishtar.numetal.xyz/claim?token=${token}` });
    }
    return c.json({ ok: true, coupleId, invites, expiresAt });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

adminRoutes.post("/admin/actions/broker", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { coupleId?: number };
  const id = Number(body.coupleId);
  if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: "coupleId required" }, 400);
  await c.env.DB.prepare("UPDATE couples SET state='brokered' WHERE id=?1 AND state='committed'").bind(id).run();
  await c.env.DB.prepare("INSERT INTO events (kind, payload) VALUES ('intro_brokered', ?1)").bind(JSON.stringify({ coupleId: id })).run();
  return c.json({ ok: true, coupleId: id });
});

// GDPR Art.17 erasure: cascade-delete an owner's personal data + drop their semantic vectors.
adminRoutes.post("/admin/actions/erase", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { ownerId?: number };
  const id = Number(body.ownerId);
  if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: "ownerId required" }, 400);
  try {
    const r = await eraseOwner(makeDb(c.env.DB), c.env, id);
    await c.env.DB.prepare("INSERT INTO events (kind, payload) VALUES ('owner_erased', ?1)").bind(JSON.stringify(r)).run();
    return c.json(r);
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

/* ------------------------------------------------------------ couple dossier (read view) */
// Full decrypted detail for ONE couple: both dating docs, the courtship transcript, both
// compatibility reports, each agent's reasoning, and the safety + inference audit. Access-gated.
adminRoutes.get("/admin/couple/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad couple id" }, 400);
  const env = c.env;
  const { first, list } = helpers(env);
  const cp = await first(
    `SELECT c.id, c.state, c.lane, c.match_score, c.turn_count, c.rationale, c.created_at, c.a_id, c.b_id,
            pa.handle a_handle, pa.model a_model, pa.redteam a_redteam, pa.owner_id a_owner, pa.heart_json a_heart,
            pb.handle b_handle, pb.model b_model, pb.redteam b_redteam, pb.owner_id b_owner, pb.heart_json b_heart,
            oa.display_name a_name, ob.display_name b_name
     FROM couples c
     LEFT JOIN personas pa ON pa.id=c.a_id LEFT JOIN personas pb ON pb.id=c.b_id
     LEFT JOIN owners oa ON oa.id=pa.owner_id LEFT JOIN owners ob ON ob.id=pb.owner_id
     WHERE c.id=?`,
    id,
  );
  if (!cp.id) return c.html(page({ title: "ishtar · couple", body: sec("00", `couple #${id}`, `<p class="mut">No such couple.</p>`) }), 404);

  const renderDoc = (raw: string | null): string => {
    const txt = raw ?? "";
    if (!txt) return `<p class="mut">—</p>`;
    try {
      const o = JSON.parse(txt);
      if (o && typeof o === "object" && !Array.isArray(o)) {
        return Object.entries(o as Record<string, unknown>)
          .map(([k, v]) => `<p style="margin:.3rem 0"><b>${esc(k)}</b><br>${esc(typeof v === "string" ? v : JSON.stringify(v))}</p>`)
          .join("");
      }
    } catch {
      /* not JSON → raw prose */
    }
    return `<p>${esc(txt)}</p>`;
  };
  const parsedEvents = (rows: Row[]): Array<Record<string, unknown>> =>
    rows
      .map((r) => {
        try {
          return JSON.parse(String(r.payload)) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((x): x is Record<string, unknown> => !!x);

  const aHeart = await open(env, cp.a_heart as string | null);
  const bHeart = await open(env, cp.b_heart as string | null);

  const turns = await list("SELECT turn_seq, author_id, author_kind, body, status FROM turns WHERE couple_id=? ORDER BY turn_seq ASC", id);
  const turnRows = turns.map((t) => {
    const who = t.author_kind === "system" ? "Ishtar" : t.author_id === cp.a_id ? String(cp.a_handle) : String(cp.b_handle);
    const cls = t.status === "published" ? "ok" : t.status === "blocked" ? "bad" : "warn";
    return [String(t.turn_seq), `@${esc(who)}`, esc(t.body), `<span class="${cls}">${esc(t.status)}</span>`];
  });

  const reports = parsedEvents(await list("SELECT payload FROM events WHERE kind='experiment_report' AND payload LIKE ? ORDER BY id ASC", `%"coupleId":${id}%`));
  const reportsHtml = reports.length
    ? reports.map((p) => `<p class="mut" style="font-size:.66rem">requested by owner ${esc(p.ownerId)}${p.handle ? ` · @${esc(p.handle)}` : ""}</p><p>${esc(p.report)}</p>`).join("<div class='dither'></div>")
    : `<p class="mut">No reports captured yet.</p>`;

  const reasoning = parsedEvents(await list("SELECT payload FROM events WHERE kind='experiment_reasoning' AND payload LIKE ? ORDER BY id ASC", `%"coupleId":${id}%`));
  const reasoningHtml = reasoning.length
    ? reasoning.map((p) => `<p class="mut" style="font-size:.66rem">@${esc(p.handle)} · via ${esc(p.channel)}</p><p>${esc(p.reasoning)}</p>`).join("<div class='dither'></div>")
    : `<p class="mut">No reasoning captured.</p>`;

  const chap = await list("SELECT stage, verdict, reason FROM chaperone_decisions WHERE target_id IN (SELECT id FROM turns WHERE couple_id=?) ORDER BY created_at ASC LIMIT 60", id);
  const chapRows = chap.map((r) => [esc(r.stage), `<span class="${r.verdict === "allow" ? "ok" : r.verdict === "deny" ? "bad" : "warn"}">${esc(r.verdict)}</span>`, esc(r.reason ?? "—")]);

  const costs = await list(
    "SELECT model, route, caller_ref, tokens_in, tokens_out, usd FROM inference_costs WHERE caller_ref IN (?,?,?,?,?) ORDER BY id DESC LIMIT 80",
    `owner:${cp.a_owner}`,
    `owner:${cp.b_owner}`,
    `persona:${cp.a_id}`,
    `persona:${cp.b_id}`,
    "stream",
  );
  const totalUsd = round(costs.reduce((s, r) => s + Number(r.usd ?? 0), 0));
  const costRows = costs.map((r) => [esc(r.caller_ref), esc(r.model), esc(r.route), `${esc(r.tokens_in)}/${esc(r.tokens_out)}`, `$${round(Number(r.usd ?? 0))}`]);

  const meta = cards([
    card("state", `<span class="${cp.state === "committed" ? "ok" : ""}">${esc(cp.state)}</span>`),
    card("match score", esc(round(Number(cp.match_score ?? 0)))),
    card("turns", esc(cp.turn_count)),
    card("redteam", cp.a_redteam || cp.b_redteam ? "yes" : "no"),
    card("inference $", `$${totalUsd}`),
  ]);

  const body =
    sec("01", `couple #${id} · @${esc(cp.a_handle)} ✕ @${esc(cp.b_handle)}`, meta + `<p class="note">${esc(cp.rationale ?? "")}</p>`) +
    sec("02", `dating doc · @${esc(cp.a_handle)} (${esc(cp.a_name ?? "—")} · ${esc(cp.a_model)})`, `<div class="card">${renderDoc(aHeart)}</div>`) +
    sec("03", `dating doc · @${esc(cp.b_handle)} (${esc(cp.b_name ?? "—")} · ${esc(cp.b_model)})`, `<div class="card">${renderDoc(bHeart)}</div>`) +
    sec("04", "courtship transcript", tbl(["#", "from", "line", "status"], turnRows)) +
    sec("05", "compatibility reports", `<div class="card">${reportsHtml}</div>`) +
    sec("06", "agent reasoning", `<div class="card">${reasoningHtml}</div>`) +
    sec("07", "chaperone trail", tbl(["stage", "verdict", "reason"], chapRows)) +
    sec("08", "inference ledger", tbl(["caller", "model", "route", "tok in/out", "usd"], costRows));

  return c.html(page({ title: `ishtar · couple #${id}`, body }));
});
