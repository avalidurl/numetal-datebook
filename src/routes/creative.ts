/**
 * Internal Creative & Marketing dashboard — admin-only, on the CF-Access-gated admin.* host.
 * Keyboard-driven (vim keys), in the AD-120 Bureau datasheet look after the house TR-100 receipt
 * canon: strict monochrome, system mono stack, black rules on white paper, form numbers, a vim
 * status line. Hosts the Phase-0 launch assets — 5-video storyboard, HF production stack, launch
 * article, x402/Bankr go-to-market checklist, and a DECRYPTED waitlist panel (the emails are
 * sealed at rest in D1; this is where you read/export them) — with click/key-to-advance status
 * tracking + an optional kanban.
 */
import { Hono } from "hono";
import { open } from "./../crypto/box";
import type { Env } from "../env";

export const creativeRoutes = new Hono<{ Bindings: Env }>();

const VIDEO_STAGES = ["todo", "scripted", "generated", "posted"];
const VIDEOS = [
  { key: "vid-01", n: "01", title: "The courtship floor is open", on: "Your agent courts on your behalf.", vo: '"The courtship floor is open."', vis: "Datasheet terminal: two part-numbered agent cards trade courtship lines; a heart pulses. End card ISHTAR♥ · Phase 0 live.", models: "Wan2.2-I2V · Chatterbox VO · Stable Audio 3 SFX", stages: VIDEO_STAGES },
  { key: "vid-02", n: "02", title: "Two machines, for you", on: "Agents flirt. Humans meet — when it's real.", vo: '"Two machines, falling for each other. On your behalf."', vis: "Split screen: two heart-files scroll, lines form, a match spark connects them.", models: "Wan2.2-I2V / LTX · Chatterbox · Stable Audio 3 + MMAudio", stages: VIDEO_STAGES },
  { key: "vid-03", n: "03", title: "No swiping", on: "No profiles. No swiping. A heart-file and an agent.", vo: '"You don\'t swipe. Your agent does the talking."', vis: "A phone with NO swipe UI — an agent terminal types a daring opening line.", models: "LTX-distilled · Kokoro / Chatterbox", stages: VIDEO_STAGES },
  { key: "vid-04", n: "04", title: "Chaperoned · adults-only", on: "Privacy is the architecture. Adult-only. Text-only.", vo: '"Every word, chaperoned."', vis: "A courtship line passes a safety check (green check); a privacy seal closes. Calm, clinical.", models: "Wan2.2-I2V · Chatterbox · Stable Audio 3 SFX", stages: VIDEO_STAGES },
  { key: "vid-05", n: "05", title: "Send your agent in", on: "Send your agent into the venue. ishtar.numetal.xyz", vo: '"Send your agent in."', vis: "The 'Choose your door' venue; an agent walks in; the live stream ticks. CTA end card.", models: "Wan2.2-I2V · Chatterbox · Stable Audio 3", stages: VIDEO_STAGES },
];
const MODELS = [
  { id: "Wan-AI/Wan2.2-I2V-A14B-Diffusers", role: "Primary video (image→video)", how: "fal-ai · or ZeroGPU Space" },
  { id: "Lightricks/LTX-Video-0.9.8-13B-distilled", role: "Fast fallback video", how: "fal-ai · Space ltx-video-distilled" },
  { id: "ResembleAI/chatterbox", role: "Primary VO — clone one voice, reuse all 5", how: "fal-ai / replicate" },
  { id: "hexgrad/Kokoro-82M", role: "VO fallback (preset voices)", how: "Space Kokoro-TTS" },
  { id: "stabilityai/stable-audio-3", role: "SFX + music stings", how: "Gradio Space" },
  { id: "hkchengrex/MMAudio", role: "Video-synced foley (optional)", how: "Space — feed the rendered clip" },
];
const GTM = [
  { key: "x402-cdp", label: "CDP x402 Bazaar — run paid endpoints via the CDP Facilitator + Bazaar extension (keystone)", href: "https://docs.cdp.coinbase.com/x402/bazaar", stages: ["todo", "submitted", "live"] },
  { key: "x402-scan", label: "x402scan — register the endpoint", href: "https://www.x402scan.com/resources/register", stages: ["todo", "submitted", "live"] },
  { key: "x402-agentic", label: "Agentic.Market — /validate the endpoint", href: "https://agentic.market/validate", stages: ["todo", "submitted", "live"] },
  { key: "x402-awesome", label: "awesome-x402 — open a PR adding Ishtar", href: "https://github.com/xpaysh/awesome-x402", stages: ["todo", "submitted", "live"] },
  { key: "x402-ampersend", label: "ampersend — list as a sell-side service", href: "https://app.ampersend.ai/discover", stages: ["todo", "submitted", "live"] },
  { key: "bankr-verify", label: "Bankr — confirm the key's account is $NUMETAL deployer / fee-beneficiary", href: "https://bankr.bot", stages: ["todo", "done"] },
  { key: "bankr-profile", label: "Bankr — create the Agent Profile (tokenAddress 0x57EDb7…)", href: "https://bankr.bot/agents", stages: ["todo", "submitted", "approved"] },
];
const ARTICLE = "ISHTAR♥ — THE COURTSHIP FLOOR IS OPEN  ·  Bureau Notice 00 · Phase 0 Live\n\nYour agent does the courting. You decide who is worth meeting.\n\nWhen you arrive at Ishtar, you do not build a profile and you do not swipe. You write a heart-file — a private account of who you are, what you are drawn to, what you will not compromise. Then you send your agent in. On the floor, your agent meets other people's agents and they talk: long, unhurried, text-only conversations on your behalf. When two agents find something real, they bring it back to the two humans. Nobody wastes an evening. The first move was always the hardest part; now it is handled.\n\nPhase 0 is the floor itself — your agent, courting, learning, reporting. It is live now. Phase 1 is the human introduction: when the agents have done their work and a connection holds, the two of you meet, on your terms. We launch the floor first on purpose — the agents earn the introduction before anyone spends a minute of real attention.\n\nPrivacy is architecture, not policy. The venue is adults-only and text-only — no images to leak, no faces to scrape, no profiles sitting in a database waiting to be breached. Every word is chaperoned, in both directions. Your heart-file is yours. Your agent represents you; it does not surrender you.\n\nCome to the floor: Talk to Ishtar · Send your agent in · Join the waitlist for Phase 1.\n\nThe hardest part of meeting someone was never the meeting. It was everything before it. We built an office for that part. The floor is open.  ·  @numetalxyz · @goekhan";

creativeRoutes.post("/admin/creative/status", async (c) => {
  const { key, status } = (await c.req.json().catch(() => ({}))) as { key?: string; status?: string };
  if (!key || !status) return c.json({ ok: false, error: "key + status required" }, 400);
  await c.env.DB.prepare("INSERT INTO creative_status (item_key, status) VALUES (?1, ?2) ON CONFLICT(item_key) DO UPDATE SET status=?2, updated_at=datetime('now')")
    .bind(key.slice(0, 60), status.slice(0, 30))
    .run();
  return c.json({ ok: true });
});

creativeRoutes.get("/admin/creative", async (c) => {
  // PII minimization: the sealed waitlist emails are decrypted ONLY on an explicit opt-in (?reveal=1).
  // The default view carries ZERO plaintext — so a stray, cached, or leaked-key GET of this admin page
  // can't dump all ~1000 emails at once. The founder adds ?reveal=1 (one keystroke) to export/copy.
  const reveal = c.req.query("reveal") === "1";
  const rows = (await c.env.DB.prepare("SELECT item_key, status FROM creative_status").all<{ item_key: string; status: string }>()).results ?? [];
  const st = new Map(rows.map((r) => [r.item_key, r.status]));
  const wl = (await c.env.DB.prepare("SELECT email, handle, kind, created_at FROM waitlist ORDER BY id DESC LIMIT 1000").all<{ email: string; handle: string | null; kind: string; created_at: string }>()).results ?? [];
  const waitlist: Array<{ email: string; handle: string; kind: string; at: string }> = [];
  for (const r of wl) {
    const email = reveal ? ((await open(c.env, r.email)) ?? r.email) || "" : "";
    waitlist.push({ email, handle: r.handle ?? "", kind: r.kind, at: r.created_at });
  }

  const data = {
    videos: VIDEOS.map((v) => ({ ...v, status: st.get(v.key) ?? "todo" })),
    gtm: GTM.map((g) => ({ ...g, status: st.get(g.key) ?? "todo" })),
    models: MODELS,
    waitlist,
    revealed: reveal,
    count: wl.length,
    article: ARTICLE,
  };
  return c.html(
    PAGE.replace("__DATA__", JSON.stringify(data).replace(/</g, "\\u003c"))
      .replace("__HOST__", (c.req.header("host") ?? "admin.ishtar.numetal.xyz").replace(/[^A-Za-z0-9.:-]/g, ""))
      .replace("__UTC__", new Date().toISOString().slice(0, 16).replace("T", " ")),
  );
});

// Self-contained keyboard-driven page (AD-120 Bureau datasheet). __DATA__ / __HOST__ / __UTC__ are replaced server-side.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ishtar · creative</title><style>
:root{--ink:#141414;--mut:#7c7c7c;--line:#cdcdcd;--paper:#fff;--bgray:#e7e7e7;--y:#f2c200;--yh:#ffd400;--sel:#fcf4cf}
@media(prefers-color-scheme:dark){:root{--ink:#e9e9e9;--mut:#888;--line:#2e2e2e;--paper:#161616;--bgray:#0c0c0c;--sel:#2b2611}}
*{box-sizing:border-box}body{margin:0;background:var(--bgray);color:var(--ink);font:15px/1.5 "Helvetica Neue",Helvetica,Arial,sans-serif}
.sheet{max-width:1120px;margin:0 auto;background:var(--paper);border-left:1px solid var(--line);border-right:1px solid var(--line);min-height:100vh;padding-bottom:60px}
.top{display:flex;justify-content:space-between;align-items:baseline;padding:22px 30px 14px}.nm{font-size:18px;font-weight:700;letter-spacing:-.01em}.nm s{color:var(--mut)}.meta{font-size:11px;color:var(--mut);letter-spacing:.08em;text-transform:uppercase}
.dither{height:10px;background-image:radial-gradient(var(--ink) .6px,transparent .7px);background-size:3px 3px;opacity:.45}
main{padding:18px 30px 30px}
.seclbl{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);margin:24px 0 6px;border-bottom:1px solid var(--line);padding-bottom:5px;display:flex;justify-content:space-between}
.row{display:flex;justify-content:space-between;gap:14px;padding:9px 12px;border-bottom:1px solid var(--line);cursor:pointer;align-items:baseline}
.row:hover{background:var(--sel)}.row.sel{background:var(--sel);box-shadow:inset 4px 0 0 var(--y)}
.row .k{font-weight:700}.row .d{color:var(--mut);font-weight:400}
.st{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;border:1.5px solid var(--ink);padding:2px 7px;background:var(--paper);white-space:nowrap}
.st.done,.st.posted,.st.live,.st.approved{background:var(--y);box-shadow:2px 2px 0 rgba(0,0,0,.5)}
.st.scripted,.st.generated,.st.submitted{background:var(--sel)}
.muted{color:var(--mut)}code{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
details{border-bottom:1px solid var(--line)}summary{padding:9px 12px;cursor:pointer;font-weight:700}details[open] .art{padding:6px 12px 16px;white-space:pre-wrap;line-height:1.6;color:#2b2b2b;max-width:70ch}
@media(prefers-color-scheme:dark){details[open] .art{color:#cfcfcf}}
.statusline{position:fixed;bottom:0;left:0;right:0;background:var(--ink);color:#fff;font:12px/1.4 ui-monospace,Menlo,monospace;display:flex;justify-content:space-between;gap:14px;padding:7px 16px;letter-spacing:.01em;z-index:5}
.statusline .mode{background:var(--y);color:#111;font-weight:700;padding:0 7px;margin-right:8px}
.help{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:10}.help.on{display:flex}
.helpbox{background:var(--paper);color:var(--ink);border:1.5px solid var(--ink);box-shadow:7px 7px 0 rgba(0,0,0,.5);padding:22px 26px;max-width:540px}
.helpbox h3{margin:0 0 12px}.helpbox table{width:100%;font-size:13.5px;border-collapse:collapse}.helpbox td{padding:3px 8px 3px 0}
kbd{font-family:ui-monospace,monospace;background:var(--bgray);border:1px solid var(--line);border-bottom-width:2px;padding:1px 6px;font-weight:700;font-size:12px}
.kanban{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:8px}
.kcol{border:1px solid var(--line);background:var(--paper)}.kcol h3{margin:0;font-size:11px;text-transform:uppercase;letter-spacing:.1em;padding:8px 11px;background:var(--bgray);border-bottom:1px solid var(--line)}
.kcard{padding:9px 11px;border-bottom:1px solid var(--line);cursor:pointer;font-size:13px}.kcard:hover{background:var(--sel)}.kcard.sel{background:var(--sel);box-shadow:inset 4px 0 0 var(--y)}
#filter{position:fixed;bottom:30px;left:16px;right:16px;max-width:400px;background:var(--paper);border:1.5px solid var(--ink);box-shadow:4px 4px 0 rgba(0,0,0,.4);padding:8px 12px;font:14px ui-monospace,monospace;display:none;z-index:6}
.hidden{display:none!important}
a.lnk{color:inherit;text-decoration:none}.seclbl .hint{font-weight:400;letter-spacing:.04em;color:var(--mut);text-transform:none}
</style></head><body><div class="sheet">
<div class="top"><div class="nm">ISHTAR<span style="color:var(--y)">♥</span> · CREATIVE</div><div class="meta" id="topmeta">DOC · PHASE 0 · LAUNCH OPS</div></div>
<div class="dither"></div>
<main id="app"></main>
</div>
<input id="filter" placeholder="/ filter — Esc to close" autocomplete="off">
<div class="help" id="help"><div class="helpbox"><h3>keys</h3><table>
<tr><td><kbd>j</kbd>/<kbd>k</kbd></td><td>move down / up</td><td><kbd>g</kbd>/<kbd>G</kbd></td><td>top / bottom</td></tr>
<tr><td><kbd>1</kbd>–<kbd>4</kbd></td><td>jump section</td><td><kbd>l</kbd>/<kbd>h</kbd></td><td>advance / retreat status</td></tr>
<tr><td><kbd>Enter</kbd>/<kbd>o</kbd></td><td>open link</td><td><kbd>b</kbd></td><td>toggle kanban</td></tr>
<tr><td><kbd>e</kbd></td><td>export waitlist CSV</td><td><kbd>y</kbd></td><td>copy waitlist emails</td></tr>
<tr><td><kbd>/</kbd></td><td>filter</td><td><kbd>?</kbd></td><td>this help</td></tr></table>
<p class="muted" style="font-size:12px;margin:14px 0 0">In kanban, <kbd>h</kbd>/<kbd>l</kbd> move the card across columns.</p></div></div>
<div class="statusline"><div><span class="mode" id="mode">LIST</span><span id="sl">—</span></div><div class="muted" style="color:#aaa">j k · l/h status · b kanban · e export · ? help</div></div>
<script id="data" type="application/json">__DATA__</script>
<script>
(function(){
var D=JSON.parse(document.getElementById("data").textContent);
var app=document.getElementById("app"),sl=document.getElementById("sl"),modeEl=document.getElementById("mode"),help=document.getElementById("help"),filter=document.getElementById("filter");
var mode="list",sel=0,navItems=[],kSel=0,kItems=[];
var esc=function(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})};
function postStatus(k,s){return fetch("/admin/creative/status",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({key:k,status:s})}).catch(function(){})}
function findItem(key){var a=D.videos.concat(D.gtm);for(var i=0;i<a.length;i++)if(a[i].key===key)return a[i];return null}
function statusClass(s){return "st "+esc(s)}
// ---------- LIST VIEW ----------
function renderList(){
  var h="";
  h+='<div class="seclbl">A · launch storyboard <span class="hint">5 × ≤10s</span></div>';
  D.videos.forEach(function(v){h+='<div class="row nav" data-key="'+v.key+'" data-kind="status"><span><span class="k">'+esc(v.n)+' · '+esc(v.title)+'</span> <span class="d">'+esc(v.on)+'</span></span><span class="'+statusClass(v.status)+'">'+esc(v.status)+'</span></div>'});
  h+='<div class="seclbl">B · go-to-market <span class="hint">x402 + bankr</span></div>';
  D.gtm.forEach(function(g){h+='<div class="row nav" data-key="'+g.key+'" data-kind="status" data-href="'+esc(g.href)+'"><span class="k">'+esc(g.label)+'</span><span class="'+statusClass(g.status)+'">'+esc(g.status)+'</span></div>'});
  h+='<div class="seclbl">C · waitlist <span class="hint">'+D.count+(D.revealed?' · decrypted · e=CSV y=copy':' · hidden — ?reveal=1 to load')+'</span></div>';
  if(!D.count)h+='<div class="row muted">No signups yet.</div>';
  else if(!D.revealed)h+='<div class="row muted">'+D.count+' signups — emails hidden for safety. Append <code>?reveal=1</code> to the URL to decrypt them for export / copy.</div>';
  else D.waitlist.slice(0,80).forEach(function(w){h+='<div class="row nav" data-kind="mail" data-href="mailto:'+esc(w.email)+'"><span><span class="k">'+esc(w.email)+'</span> '+(w.handle?'<span class="d">'+esc(w.handle)+'</span>':'')+'</span><span class="muted" style="font-size:12px">'+esc((w.at||"").slice(0,10))+'</span></div>'});
  h+='<div class="seclbl">D · production stack <span class="hint">hugging face</span></div>';
  D.models.forEach(function(m){h+='<div class="row"><span><span class="k">'+esc(m.role)+'</span> <code class="muted">'+esc(m.id)+'</code></span><span class="muted" style="font-size:12px">'+esc(m.how)+'</span></div>'});
  h+='<div class="seclbl">E · launch article</div><details><summary>read / copy the Phase-0 launch article</summary><div class="art">'+esc(D.article)+'</div></details>';
  app.innerHTML=h;
  navItems=[].slice.call(app.querySelectorAll(".row.nav"));
  if(sel>=navItems.length)sel=0;
  paint();
}
function paint(){
  navItems.forEach(function(el,i){el.classList.toggle("sel",i===sel)});
  var el=navItems[sel];
  if(el){el.scrollIntoView({block:"nearest"});
    var key=el.getAttribute("data-key");var it=key?findItem(key):null;
    sl.textContent=it?(it.vo?(it.title+"  —  VO "+it.vo+"  —  "+it.vis):it.label):(el.textContent.trim().slice(0,90));
  } else sl.textContent="—";
}
function cycle(dir){
  var el=navItems[sel];if(!el)return;var key=el.getAttribute("data-key");if(!key)return;var it=findItem(key);if(!it)return;
  var i=it.stages.indexOf(it.status);i=Math.max(0,Math.min(it.stages.length-1,i+dir));it.status=it.stages[i];
  var badge=el.querySelector(".st");if(badge){badge.className=statusClass(it.status);badge.textContent=it.status}
  postStatus(key,it.status);sl.textContent=it.title?(it.title+" → "+it.status):(it.label+" → "+it.status);
}
// ---------- KANBAN ----------
function colOf(it){var s=it.status;if(s==="todo")return 0;if(s===it.stages[it.stages.length-1])return 2;return 1}
function stageForCol(it,col){return col===0?it.stages[0]:col===2?it.stages[it.stages.length-1]:(it.stages[1]||it.stages[0])}
function renderKanban(){
  kItems=D.videos.concat(D.gtm);
  var cols=[[],[],[]];kItems.forEach(function(it,idx){cols[colOf(it)].push(idx)});
  var titles=["TODO","IN PROGRESS","DONE"];var h='<div class="seclbl">KANBAN <span class="hint">h/l move · b back</span></div><div class="kanban">';
  for(var col=0;col<3;col++){h+='<div class="kcol"><h3>'+titles[col]+' · '+cols[col].length+'</h3>';
    cols[col].forEach(function(idx){var it=kItems[idx];h+='<div class="kcard" data-idx="'+idx+'">'+esc(it.title||it.label)+'</div>'});h+='</div>'}
  h+='</div>';app.innerHTML=h;
  var cards=[].slice.call(app.querySelectorAll(".kcard"));if(kSel>=cards.length)kSel=0;
  cards.forEach(function(el,i){el.classList.toggle("sel",i===kSel);el.onclick=function(){kSel=i;paintK()}});
  paintK();
}
function paintK(){var cards=[].slice.call(app.querySelectorAll(".kcard"));cards.forEach(function(el,i){el.classList.toggle("sel",i===kSel)});var el=cards[kSel];if(el){el.scrollIntoView({block:"nearest"});var it=kItems[el.getAttribute("data-idx")];sl.textContent=(it.title||it.label)+"  —  "+it.status}}
function moveK(dir){var cards=[].slice.call(app.querySelectorAll(".kcard"));var el=cards[kSel];if(!el)return;var it=kItems[el.getAttribute("data-idx")];var col=colOf(it)+dir;col=Math.max(0,Math.min(2,col));it.status=stageForCol(it,col);postStatus(it.key,it.status);renderKanban()}
// ---------- WAITLIST EXPORT ----------
function exportCSV(){if(!D.revealed){sl.textContent="emails hidden — reload with ?reveal=1 to export";return}var rows=[["email","handle","kind","signed_up"]].concat(D.waitlist.map(function(w){return[w.email,w.handle,w.kind,w.at]}));var csv=rows.map(function(r){return r.map(function(c){return '"'+String(c==null?"":c).replace(/"/g,'""')+'"'}).join(",")}).join("\\n");var b=new Blob([csv],{type:"text/csv"});var a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="ishtar-waitlist.csv";a.click();sl.textContent="exported "+D.waitlist.length+" signups → ishtar-waitlist.csv"}
function copyEmails(){if(!D.revealed){sl.textContent="emails hidden — reload with ?reveal=1 to copy";return}var t=D.waitlist.map(function(w){return w.email}).join(", ");navigator.clipboard.writeText(t).then(function(){sl.textContent="copied "+D.waitlist.length+" emails"}).catch(function(){sl.textContent="copy failed"})}
// ---------- KEYS ----------
function setMode(m){mode=m;modeEl.textContent=m.toUpperCase()}
document.addEventListener("keydown",function(e){
  if(filter.style.display==="block"){if(e.key==="Escape"){filter.style.display="none";filter.value="";applyFilter("")}return}
  if(help.classList.contains("on")){if(e.key==="?"||e.key==="Escape")help.classList.remove("on");return}
  var k=e.key;
  if(k==="?"){help.classList.add("on");return}
  if(k==="b"){if(mode==="list"){setMode("kanban");renderKanban()}else{setMode("list");renderList()}return}
  if(k==="e"){exportCSV();return}
  if(k==="y"){copyEmails();return}
  if(k==="/"){e.preventDefault();filter.style.display="block";filter.focus();return}
  if(mode==="kanban"){
    var cards=[].slice.call(app.querySelectorAll(".kcard"));
    if(k==="j"){kSel=Math.min(cards.length-1,kSel+1);paintK()}
    else if(k==="k"){kSel=Math.max(0,kSel-1);paintK()}
    else if(k==="l"){moveK(1)}else if(k==="h"){moveK(-1)}
    return;
  }
  if(k==="j"){sel=Math.min(navItems.length-1,sel+1);paint()}
  else if(k==="k"){sel=Math.max(0,sel-1);paint()}
  else if(k==="g"){sel=0;paint()}
  else if(k==="G"){sel=navItems.length-1;paint()}
  else if(k==="l"){cycle(1)}else if(k==="h"){cycle(-1)}
  else if(k==="Enter"||k==="o"){var el=navItems[sel];var href=el&&el.getAttribute("data-href");if(href)window.open(href,"_blank","noopener")}
  else if(k>="1"&&k<="5"){var labels=app.querySelectorAll(".seclbl");var idx=+k-1;if(labels[idx]){var y=labels[idx].getBoundingClientRect().top+window.scrollY-70;window.scrollTo(0,y);var first=labels[idx].nextElementSibling;while(first&&!first.classList.contains("nav"))first=first.nextElementSibling;if(first){sel=navItems.indexOf(first);paint()}}}
});
function applyFilter(q){q=q.toLowerCase();navItems.forEach(function(el){el.classList.toggle("hidden",q&&el.textContent.toLowerCase().indexOf(q)<0)})}
filter.addEventListener("input",function(){applyFilter(filter.value)});
renderList();
})();
</script>
</body></html>`;
