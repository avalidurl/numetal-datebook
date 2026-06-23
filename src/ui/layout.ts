/**
 * The Bureau — house style for the operator console (the only consumer of page()).
 * Matches the public brand sites (agentbounty.dev / numetal.xyz) and the /admin/creative
 * dashboard: Helvetica grotesque, ink-on-paper "sheet", a single #f2c200 yellow accent with
 * hard offset shadows, dither-dot dividers, part-numbered uppercase section stamps — plus a
 * vim-style keyboard layer (j/k between sections, 1–9 jump, / filter, ? help) and a status line.
 * One source of truth — pages compose page()/sec()/card(); never re-style inline.
 */
export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]!);
}

const STYLE = `<style>
:root{--bg:#e7e7e7;--paper:#fff;--card:#fff;--ink:#141414;--mut:#6f6f68;--faint:#9c9c93;--line:#cdcdcd;--line2:#ececE4;--y:#f2c200;--yh:#ffd400;--sel:#fcf4cf;--ok:#1a7f43;--warn:#9a6a00;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#0c0c0c;--paper:#161613;--card:#18181a;--ink:#e9e9e2;--mut:#9b9b90;--faint:#6b6b62;--line:#2e2e2e;--line2:#222;--sel:#2b2611;--ok:#4ad07f;--warn:#e0a93a;--bad:#ff6b5e}}
*{box-sizing:border-box}
body{font-family:"Helvetica Neue",Helvetica,Arial,"Liberation Sans",sans-serif;background:var(--bg);color:var(--ink);margin:0;line-height:1.5;font-size:13.5px;-webkit-font-smoothing:antialiased}
.wrap{max-width:1120px;margin:0 auto;background:var(--paper);border-left:1px solid var(--line);border-right:1px solid var(--line);min-height:100vh;padding:1.1rem 1.6rem 3.8rem}
a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line)}a:hover{border-bottom-color:var(--ink);background:var(--sel)}
h1{font-size:1.15rem;font-weight:700;margin:0;letter-spacing:-.01em}
.hrt{color:var(--y)}
.reg{color:var(--faint);font-size:.68rem;letter-spacing:.07em;text-transform:uppercase}
.dither{height:10px;background-image:radial-gradient(var(--ink) .6px,transparent .7px);background-size:3px 3px;opacity:.42;margin:.7rem 0 .2rem}
.sec{margin-top:1.6rem;scroll-margin-top:.6rem}
.sec>h2{font-size:.72rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);border-bottom:1px solid var(--line);padding-bottom:.32rem;margin:0 0 .65rem}
.sec>h2 .n{color:var(--faint);margin-right:.5rem}
.sec.cur>h2{color:var(--ink);background:var(--sel);box-shadow:inset 4px 0 0 var(--y);padding-left:.5rem}
.grid{display:flex;flex-wrap:wrap;gap:.6rem}
.card{border:1px solid var(--line);background:var(--card);border-radius:0;padding:.65rem .85rem;min-width:170px;flex:1}
.card .k{color:var(--faint);font-size:.64rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.card .v{font-size:1.05rem;margin-top:.22rem}
.card .v small{color:var(--mut);font-size:.72rem}
table{width:100%;border-collapse:collapse;font-size:.76rem;margin-top:.2rem}
th{text-align:left;color:var(--faint);font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-size:.62rem;padding:.3rem .5rem;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:.32rem .5rem;border-bottom:1px solid var(--line2);vertical-align:top}
tr:hover td{background:var(--sel)}
code{background:var(--line2);padding:.04rem .3rem;border-radius:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em;word-break:break-word}
button,.btn{font:inherit;font-size:.73rem;font-weight:700;color:var(--ink);background:var(--paper);border:1.5px solid var(--ink);border-radius:0;padding:.34rem .7rem;cursor:pointer;box-shadow:2px 2px 0 rgba(0,0,0,.5);transition:background .1s,transform .05s,box-shadow .05s}
button:hover,.btn:hover{background:var(--y)}
button:active,.btn:active{transform:translate(2px,2px);box-shadow:none}
input,select{font:inherit;font-size:.76rem;background:var(--paper);color:var(--ink);border:1.5px solid var(--ink);border-radius:0;padding:.3rem .45rem}
input:focus,select:focus{outline:none;box-shadow:2px 2px 0 var(--y)}
.bar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.pill{font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:.08rem .42rem;border:1px solid var(--line);border-radius:0;color:var(--mut)}
.ok{color:var(--ok);font-weight:700}.warn{color:var(--warn);font-weight:700}.bad{color:var(--bad);font-weight:700}.mut{color:var(--mut)}
.note{color:var(--faint);font-size:.72rem;margin-top:1.4rem;line-height:1.6}
#toast{position:sticky;top:0;z-index:9;background:var(--y);color:#111;padding:.42rem .7rem;border:1.5px solid var(--ink);box-shadow:2px 2px 0 rgba(0,0,0,.5);font-size:.75rem;font-weight:700;display:none;margin-bottom:.6rem}
.statusline{position:fixed;bottom:0;left:0;right:0;background:var(--ink);color:#fff;font:12px/1.4 ui-monospace,Menlo,monospace;display:flex;justify-content:space-between;gap:14px;padding:7px 16px;letter-spacing:.01em;z-index:50}
.statusline .mode{background:var(--y);color:#111;font-weight:700;padding:0 7px;margin-right:8px}
.statusline .hint{color:#aaa}
.opsfilter{position:fixed;bottom:34px;left:14px;right:14px;max-width:420px;background:var(--paper);color:var(--ink);border:1.5px solid var(--ink);box-shadow:4px 4px 0 rgba(0,0,0,.4);padding:8px 12px;font:14px ui-monospace,monospace;display:none;z-index:51}
.help{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:60}
.help.on{display:flex}
.helpbox{background:var(--paper);color:var(--ink);border:1.5px solid var(--ink);box-shadow:7px 7px 0 rgba(0,0,0,.5);padding:22px 26px;max-width:560px}
.helpbox h3{margin:0 0 12px;font-size:.95rem}
.helpbox table{width:100%;font-size:13px;border-collapse:collapse;margin:0}
.helpbox td{padding:3px 10px 3px 0;border:none}
kbd{font-family:ui-monospace,monospace;background:var(--bg);border:1px solid var(--line);border-bottom-width:2px;padding:1px 6px;font-weight:700;font-size:12px}
</style>`;

// Fixed chrome appended after .wrap: vim status line, section filter, help overlay, and the
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

export function page(opts: { title: string; body: string }): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title>${STYLE}<body><div class="wrap">${opts.body}</div>${CHROME}</body>`;
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
  if (!rows.length) return `<p class="mut" style="font-size:.78rem">—</p>`;
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
