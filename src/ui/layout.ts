/**
 * The Bureau — shared house style for every HTML surface (ops console, lurk, claim,
 * landing). Monospace datasheet register: ink-on-paper, thin rules, part-numbered
 * sections, one restrained accent. Light by default; flips for dark mode.
 * One source of truth — pages compose page()/sec()/card(); never re-style inline.
 */
export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]!);
}

const STYLE = `<style>
:root{--bg:#fbfbf9;--card:#fff;--ink:#1b1b18;--mut:#6f6f68;--faint:#9c9c93;--line:#dcdcd3;--line2:#ececE4;--accent:#2f53c9;--ok:#1a7f43;--warn:#9a6a00;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e0c;--card:#161613;--ink:#e9e9e2;--mut:#9b9b90;--faint:#6b6b62;--line:#2b2b26;--line2:#1f1f1b;--accent:#88a0ff;--ok:#4ad07f;--warn:#e0a93a;--bad:#ff6b5e}}
*{box-sizing:border-box}
body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);color:var(--ink);margin:0;line-height:1.5;font-size:13px}
.wrap{max-width:1120px;margin:0 auto;padding:1.1rem 1rem 3rem}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:1.1rem;font-weight:600;margin:0;letter-spacing:.01em}
.reg{color:var(--faint);font-size:.7rem;letter-spacing:.05em;text-transform:uppercase}
.sec{margin-top:1.5rem}
.sec>h2{font-size:.72rem;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--mut);border-bottom:1px solid var(--line);padding-bottom:.3rem;margin:0 0 .65rem}
.sec>h2 .n{color:var(--faint);margin-right:.5rem}
.grid{display:flex;flex-wrap:wrap;gap:.6rem}
.card{border:1px solid var(--line);background:var(--card);border-radius:6px;padding:.65rem .85rem;min-width:170px;flex:1}
.card .k{color:var(--faint);font-size:.66rem;text-transform:uppercase;letter-spacing:.05em}
.card .v{font-size:1.02rem;margin-top:.22rem}
.card .v small{color:var(--mut);font-size:.72rem}
table{width:100%;border-collapse:collapse;font-size:.76rem;margin-top:.2rem}
th{text-align:left;color:var(--faint);font-weight:500;text-transform:uppercase;letter-spacing:.04em;font-size:.64rem;padding:.3rem .5rem;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:.32rem .5rem;border-bottom:1px solid var(--line2);vertical-align:top}
tr:hover td{background:var(--line2)}
code{background:var(--line2);padding:.04rem .3rem;border-radius:3px;font-size:.92em;word-break:break-word}
button,.btn{font:inherit;font-size:.74rem;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:5px;padding:.36rem .65rem;cursor:pointer}
button:hover,.btn:hover{border-color:var(--accent);color:var(--accent)}
input,select{font:inherit;font-size:.76rem;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:5px;padding:.32rem .45rem}
.bar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.pill{font-size:.64rem;text-transform:uppercase;letter-spacing:.04em;padding:.08rem .42rem;border:1px solid var(--line);border-radius:99px;color:var(--mut)}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.mut{color:var(--mut)}
.note{color:var(--faint);font-size:.72rem;margin-top:1.4rem}
#toast{position:sticky;top:0;z-index:9;background:var(--accent);color:#fff;padding:.4rem .7rem;border-radius:5px;font-size:.75rem;display:none;margin-bottom:.6rem}
</style>`;

export function page(opts: { title: string; body: string }): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title>${STYLE}<body><div class="wrap">${opts.body}</div></body>`;
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
