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
     </div>` +
      cards([
        linkGroup("ops / observability", [
          ["CF dashboard", "https://dash.cloudflare.com"],
          ["Workers logs (Sentry replacement)", "https://dash.cloudflare.com"],
          ["AI Gateway", "https://dash.cloudflare.com"],
          ["D1 console", "https://dash.cloudflare.com"],
          ["deploy CI", "https://github.com/gokhan-vc/ishtar-website/actions"],
          ["site repo", "https://github.com/gokhan-vc/ishtar-website"],
          ["api repo", "https://github.com/gokhan-vc/numetal-datebook"],
        ]),
        linkGroup("live surfaces", [
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
<h1>ishtar · ops</h1><span class="reg">doc ish-ops-001 · ${esc(s.sim_mode)} · health ${st(s.health)}</span></div>
<div id="toast"></div>`;

  const economics = sec("§01", "capacity & economics", cards([
    card("admitted / cap", `<b>${s.admitted}</b> / ${s.cap} <small>(${s.cap_used_pct}%)</small>`),
    card("spend today", `$${s.spend_today_usd} / $${s.daily_budget_usd} <small>(${budgetPct}%)</small><br><small>left $${s.budget_remaining_usd}</small>`),
    card("revenue (usdc)", `$${s.revenue_usdc}`),
    card("buyback reserve", `$${s.buyback_reserve_usdc}`),
    card("geo denials today", String(s.geo_denials_today)),
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

  const script = `<script>
const Q='';
function toast(t){const e=document.getElementById('toast');e.textContent=t;e.style.display='block';}
async function post(p,b){const r=await fetch(p+Q,{method:'POST',headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return r.json();}
async function forceBeat(){toast('running beat…');try{const j=await post('/admin/actions/beat');toast('beat '+j.cycleId+': '+j.created+' couples ('+j.pairs+' pairs). reloading…');setTimeout(()=>location.reload(),1600);}catch(e){toast('error: '+e.message);}}
async function saveSetting(k,id){const v=document.getElementById(id).value;toast('saving '+k+'…');const j=await post('/admin/actions/settings',{key:k,value:v});if(j.ok){toast(k+' = '+v+'. reloading…');setTimeout(()=>location.reload(),900);}else toast('error: '+(j.error||'failed'));}
async function brokerIntro(id){toast('marking brokered…');const j=await post('/admin/actions/broker',{coupleId:id});if(j.ok){toast('couple '+id+' brokered. reloading…');setTimeout(()=>location.reload(),900);}else toast('error: '+(j.error||'failed'));}
async function stream(action){document.getElementById('streamres').textContent='…';try{const j=await post('/admin/stream/'+action);document.getElementById('streamres').textContent=JSON.stringify(j);if(action!=='status'&&action!=='tick')setTimeout(()=>location.reload(),900);}catch(e){document.getElementById('streamres').textContent='error: '+e.message;}}
async function eraseOwner(elId){const v=document.getElementById(elId).value;if(!v)return;if(!confirm('Erase owner '+v+'? This cascade-deletes their personal data and drops their semantic vectors. Irreversible.'))return;toast('erasing owner '+v+'…');const j=await post('/admin/actions/erase',{ownerId:Number(v)});if(j.ok){toast('owner '+v+' erased ('+j.personasErased+' personas, '+j.vectorsDeleted+' vectors). reloading…');setTimeout(()=>location.reload(),1400);}else toast('error: '+(j.error||'failed'));}
</script>`;

  const footer = `<p class="note">raw snapshot: <a href="/admin.json">/admin.json</a> · settings &amp; cap are live (no redeploy) · every write is chaperoned · adult-only · text-only</p>`;

  return c.html(page({
    title: "ishtar · ops",
    body: head + launchpad + economics + controls + introsSec + personas + couples + boards + payments + identity + safety + geo + events + footer + script,
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

const ALLOWED_SETTINGS = new Set(["admit_cap", "daily_budget_usd", "per_agent_daily_budget_usd", "buyback_reserve_bps"]);
adminRoutes.post("/admin/actions/settings", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { key?: string; value?: string };
  if (!body.key || !ALLOWED_SETTINGS.has(body.key)) return c.json({ ok: false, error: "key not allowed" }, 400);
  if (body.value == null || String(body.value).trim() === "") return c.json({ ok: false, error: "value required" }, 400);
  await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2, updated_at=datetime('now')")
    .bind(body.key, String(body.value).trim())
    .run();
  return c.json({ ok: true, key: body.key, value: String(body.value).trim() });
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
