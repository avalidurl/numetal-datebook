/**
 * AD-120 — Bureau admin datasheet layout for the Ishtar operator console (admin.* host ONLY).
 * Strict monochrome machine-report style, after the house TR-100 receipt canon: system mono
 * stack, black rules on white paper, form numbers, uppercase letter-spaced labels, inverted
 * badges for negative states. No colour. No emoji. Public pages (HeartBench view, boards,
 * system pages) keep their own layouts — this module is consumed by admin routes only.
 * Same helper API as ui/layout.ts (page/sec/card/cards/kvline/tbl/esc) — presentation only.
 */
export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]!);
}

const MONO = `ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace`;

const STYLE = `<style>
/* AD-100 kit — Bureau admin datasheet. Monochrome: #fff paper, #000 ink, #eee hover only. */
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:#fff;color:#000;font:12px/1.45 ${MONO}}
a{color:#000;text-decoration:underline;text-underline-offset:2px}
a:hover{background:#000;color:#fff;text-decoration:none}
.sheet{max-width:980px;margin:0 auto;padding:0 16px 48px}
.mast{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:14px 0 6px;border-bottom:3px double #000}
.mast .org{font-weight:700;letter-spacing:.18em;text-transform:uppercase;font-size:13px}
.mast .form{font-size:10px;letter-spacing:.14em;text-transform:uppercase}
.stamp{display:flex;gap:16px;flex-wrap:wrap;font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding:6px 0;border-bottom:1px solid #000}
h1{font-size:15px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin:22px 0 4px}
.sub{font-size:11px;margin:0 0 8px}
h2{font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;margin:26px 0 8px;padding-bottom:4px;border-bottom:1px solid #000}
h2 .no,h2 .n{display:inline-block;min-width:2.6em}
table{border-collapse:collapse;width:100%;font-size:12px}
th{font-size:10px;text-align:left;letter-spacing:.14em;text-transform:uppercase;font-weight:700;border-bottom:1px solid #000;padding:4px 12px 4px 0}
td{border-bottom:1px dotted #000;padding:4px 12px 4px 0;vertical-align:top}
tr:hover td{background:#eee}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 18px;font-size:12px}
.kv dt{font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding-top:2px}
.kv dd{word-break:break-word}
.badge{display:inline-block;border:1px solid #000;padding:0 6px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;background:#fff;color:#000}
.badge.neg{background:#000;color:#fff}
button,.btn{display:inline-block;border:1px solid #000;background:#fff;color:#000;padding:3px 10px;font:inherit;font-size:11px;letter-spacing:.1em;text-transform:uppercase;cursor:pointer;text-decoration:none}
button:hover,button:focus,.btn:hover,.btn:focus{background:#000;color:#fff;outline:none}
input,select,textarea{font:inherit;border:1px solid #000;background:#fff;color:#000;padding:3px 6px}
pre.report{border:1px solid #000;padding:10px 12px;overflow-x:auto;font-size:12px;line-height:1.35;background:#fff}
.bars{display:flex;gap:1px;align-items:flex-end}
.bars i{display:block;width:6px;height:14px;background:#000}
.bars i.dn{background:#fff;box-shadow:inset 0 0 0 1px #000}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;margin-top:10px}
.card{border:1px solid #000;padding:10px 12px}
.card .t,.card .k{font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;border-bottom:1px solid #000;padding-bottom:4px;margin-bottom:6px}
.card .v{font-size:13px}
.card .v small,.card small{font-size:10px}
.foot{margin-top:44px;padding-top:8px;border-top:1px solid #000;font-size:10px;letter-spacing:.08em;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
@media (max-width:640px){.kv{grid-template-columns:1fr}.mast{flex-direction:column;gap:2px}}
/* console extensions (same class names the pages already use) */
.sec{margin-top:26px;scroll-margin-top:6px}
.sec.cur>h2{border-bottom:3px double #000;box-shadow:inset 6px 0 0 #000;padding-left:10px}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pill{display:inline-block;border:1px solid #000;padding:0 6px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;background:#fff;color:#000}
.ok{display:inline-block;border:1px solid #000;padding:0 5px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;background:#fff;color:#000}
.warn{display:inline-block;border:1px dashed #000;padding:0 5px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;background:#fff;color:#000}
.bad{display:inline-block;border:1px solid #000;padding:0 5px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;background:#000;color:#fff}
.mut{font-size:11px}
.note{font-size:11px;margin-top:14px;line-height:1.6;max-width:78ch}
.reg{font-size:10px;letter-spacing:.14em;text-transform:uppercase}
.dither{height:0;border-bottom:1px dotted #000;margin:10px 0 4px}
code{font:inherit;font-size:11px;border:1px dotted #000;padding:0 3px;word-break:break-word}
kbd{font:inherit;font-size:11px;font-weight:700;border:1px solid #000;border-bottom-width:2px;padding:0 5px}
dialog{background:#fff;color:#000;border:1px solid #000;box-shadow:8px 8px 0 #000;max-width:860px;width:92%;padding:16px 18px}
dialog::backdrop{background:rgba(0,0,0,.55)}
#toast{position:sticky;top:0;z-index:9;background:#000;color:#fff;border:1px solid #000;padding:6px 10px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;display:none;margin-bottom:10px}
.statusline{position:fixed;bottom:0;left:0;right:0;background:#000;color:#fff;font:11px/1.4 ${MONO};display:flex;justify-content:space-between;gap:14px;padding:6px 16px;letter-spacing:.04em;z-index:50}
.statusline .mode{background:#fff;color:#000;font-weight:700;padding:0 7px;margin-right:8px}
.statusline .hint{color:#fff}
.opsfilter{position:fixed;bottom:34px;left:14px;right:14px;max-width:420px;background:#fff;color:#000;border:1px solid #000;box-shadow:4px 4px 0 #000;padding:8px 12px;font:13px ${MONO};display:none;z-index:51}
.help{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:60}
.help.on{display:flex}
.helpbox{background:#fff;color:#000;border:1px solid #000;box-shadow:6px 6px 0 #000;padding:20px 24px;max-width:560px}
.helpbox h3{margin:0 0 12px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;border:none;padding:0}
.helpbox table{width:100%;font-size:12px;border-collapse:collapse;margin:0}
.helpbox td{padding:3px 10px 3px 0;border:none}
</style>`;

// Fixed chrome appended after .sheet: vim status line, section filter, help overlay, and the
// keyboard navigation layer. Generic over any page composed of <section class="sec"> blocks.
const CHROME = `<div class="statusline"><div><span class="mode">OPS</span><span id="opsstat">—</span></div><div class="hint">j/k move · 1–9 jump · / filter · c creative · r reload · ? help</div></div>
<input id="opsfilter" class="opsfilter" placeholder="/ filter sections — Esc to close" autocomplete="off">
<div class="help" id="opshelp"><div class="helpbox"><h3>keys</h3><table>
<tr><td><kbd>j</kbd>/<kbd>k</kbd></td><td>next / prev section</td><td><kbd>g</kbd>/<kbd>G</kbd></td><td>first / last</td></tr>
<tr><td><kbd>1</kbd>–<kbd>9</kbd>,<kbd>0</kbd></td><td>jump to section N</td><td><kbd>/</kbd></td><td>filter sections</td></tr>
<tr><td><kbd>c</kbd></td><td>creative dashboard</td><td><kbd>r</kbd></td><td>reload</td></tr>
<tr><td><kbd>?</kbd></td><td>this help</td><td><kbd>Esc</kbd></td><td>close / blur field</td></tr></table>
<p class="note" style="margin-top:14px">Navigation keys are ignored while a text field is focused — press <kbd>Esc</kbd> to blur first.</p></div></div>
<script>
(function(){
var secs=[].slice.call(document.querySelectorAll('.sec'));
var sl=document.getElementById('opsstat'),help=document.getElementById('opshelp'),filt=document.getElementById('opsfilter');
var cur=0;
function isField(){var a=document.activeElement;return !!a&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);}
function label(i){var h=secs[i]&&secs[i].querySelector('h2');return h?h.textContent.trim():'—';}
function paint(scroll){secs.forEach(function(s,i){s.classList.toggle('cur',i===cur);});var s=secs[cur];if(s){if(scroll)s.scrollIntoView({block:'start',behavior:'smooth'});if(sl)sl.textContent=label(cur);}}
function move(d){if(!secs.length)return;cur=Math.max(0,Math.min(secs.length-1,cur+d));paint(true);}
function jump(i){if(i>=0&&i<secs.length){cur=i;paint(true);}}
function applyFilter(q){q=q.toLowerCase();secs.forEach(function(s){var h=s.querySelector('h2');var t=h?h.textContent.toLowerCase():'';s.style.display=(q&&t.indexOf(q)<0)?'none':'';});}
document.addEventListener('keydown',function(e){
  if(filt&&filt.style.display==='block'){if(e.key==='Escape'){filt.style.display='none';filt.value='';applyFilter('');}return;}
  if(help&&help.classList.contains('on')){if(e.key==='?'||e.key==='Escape')help.classList.remove('on');return;}
  if(isField()){if(e.key==='Escape'&&document.activeElement)document.activeElement.blur();return;}
  if(e.metaKey||e.ctrlKey||e.altKey)return;
  var k=e.key;
  if(k==='?'){if(help)help.classList.add('on');}
  else if(k==='/'){if(filt){e.preventDefault();filt.style.display='block';filt.focus();}}
  else if(k==='j')move(1);
  else if(k==='k')move(-1);
  else if(k==='g')jump(0);
  else if(k==='G')jump(secs.length-1);
  else if(k>='1'&&k<='9')jump(parseInt(k,10)-1);
  else if(k==='0')jump(9);
  else if(k==='c')window.location='/admin/creative';
  else if(k==='r')location.reload();
});
if(filt)filt.addEventListener('input',function(){applyFilter(filt.value);});
if(secs.length)paint(false);
})();
</script>`;

/** Stamp timestamp: "YYYY-MM-DD HH:MM" (UTC). */
function utcStamp(): string {
  return new Date().toISOString().slice(0, 16).replace("T", " ");
}

export function page(opts: { title: string; body: string; host?: string }): string {
  const mast = `<div class="mast"><span class="org">■ NUMETAL · ISHTAR · ADMIN</span><span class="form">FORM AD-120 · INTERNAL · ACCESS-GATED</span></div>`;
  const stamp = `<div class="stamp"><span>HOST: ${esc(opts.host ?? "admin.ishtar.numetal.xyz")}</span><span>RENDERED: ${utcStamp()} UTC</span></div>`;
  const foot = `<div class="foot"><span>NUMETAL · ISHTAR · ADMIN</span><span>AD-120 · rev 2026-07-12</span></div>`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title>${STYLE}<body><div class="sheet">${mast}${stamp}${opts.body}${foot}</div>${CHROME}</body>`;
}

export function sec(n: string, title: string, inner: string): string {
  return `<section class="sec"><h2><span class="n">${esc(n)}</span>${esc(title)}</h2>${inner}</section>`;
}

export function card(k: string, vHtml: string): string {
  return `<div class="card"><div class="k">${esc(k)}</div><div class="v">${vHtml}</div></div>`;
}

export function cards(items: string[]): string {
  return `<div class="grid">${items.join("")}</div>`;
}

/** Compact "a: b · c: d" line from grouped rows. */
export function kvline(rows: Array<Record<string, unknown>>, k: string, v: string): string {
  return rows.length ? rows.map((r) => `${esc(String(r[k]))}: <b>${esc(String(r[v]))}</b>`).join(" · ") : "—";
}

/** Table from headers + rows of pre-built (already-escaped) cell HTML. */
export function tbl(headers: string[], rows: string[][]): string {
  if (!rows.length) return `<p class="mut">—</p>`;
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
