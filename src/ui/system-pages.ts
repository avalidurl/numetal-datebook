/**
 * Branded system pages (geo-block, 404, 500) for the API Worker — on-brand with the
 * marketing site's Bureau datasheet (red-signal accent, JetBrains Mono, dim margins /
 * lighter framed column). Self-contained: links the live cross-origin ds.css + the
 * JetBrains Mono webfont, so no asset has to ship from this Worker. Light/dark via the
 * same [data-theme] toggle + prefers-color-scheme contract as ds.css.
 *
 * These render ONLY for browsers (Accept: text/html). API clients keep getting JSON —
 * see wantsHtml(). Pages are deliberately calm and detail-free (no denylist internals,
 * no stack traces) — they are public surfaces a human might stumble onto.
 */

/** True when the caller is a browser that wants a page (vs. an agent/fetch wanting JSON). */
export function wantsHtml(accept: string | undefined | null): boolean {
  return (accept ?? "").toLowerCase().includes("text/html");
}

const DS_CSS = "https://ishtar.numetal.xyz/ds.css";
const FONT =
  "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap";

/** Theme bootstrap (apply stored choice before paint) + ◐ toggle — identical contract to the site. */
const THEME_SCRIPT = `<script>
(function(){var t=localStorage.getItem("ishtar-theme");if(t)document.documentElement.setAttribute("data-theme",t);})();
function tt(){var r=document.documentElement,cur=r.getAttribute("data-theme");
if(!cur){cur=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";}
var next=cur==="dark"?"light":"dark";r.setAttribute("data-theme",next);localStorage.setItem("ishtar-theme",next);}
</script>`;

/**
 * Compose a minimal datasheet page: topbar (reg + ◐ theme), doc strip, part number,
 * ISHTAR♥ mark, a short body, caution stripe, imprint footer. `bodyHtml` is trusted,
 * pre-built markup from the callers in this file (no user input flows in).
 */
function datasheet(opts: {
  title: string;
  docline: string;
  partno: string;
  bodyHtml: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${opts.title}</title>
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONT}" rel="stylesheet">
<link rel="stylesheet" href="${DS_CSS}">
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <span class="reg">Ishtar · by Atelier G&ouml;khan Turhan</span>
    <button class="toggle" onclick="tt()" aria-label="Toggle light or dark theme">&#9685; theme</button>
  </div>
  <div class="docstrip">
    <span><span class="tick">&#9646;</span>&nbsp; ${opts.docline}</span>
    <span class="live-tag"><span class="dot"></span> Live · testnet</span>
  </div>
  <header style="padding:2.4rem 0 0;">
    <div class="partno">${opts.partno}</div>
    <h1 class="mark">ISHTAR<span class="hx">&hearts;</span></h1>
    ${opts.bodyHtml}
  </header>
  <div class="stripe"></div>
  <footer>
    <div class="imprint">
      <span>Atelier G&ouml;khan Turhan · made by machines · adult-only (18+)</span>
      <span><a href="https://ishtar.numetal.xyz/">ishtar.numetal.xyz &#8599;</a></span>
    </div>
  </footer>
</div>
${THEME_SCRIPT}
</body>
</html>`;
}

/**
 * Bureau shell for an interactive Worker-served page (e.g. the Privy claim flow).
 * Same self-contained datasheet chrome as datasheet() — links the cross-origin ds.css
 * + JetBrains Mono and the ◐ theme toggle — but lets the caller inject extra <head>
 * markup (module scripts) and trusted body HTML (a mount point). `headHtml` and
 * `bodyHtml` are TRUSTED, pre-built strings from this package; never pass user input.
 */
export function claimShell(opts: {
  title: string;
  docline: string;
  partno: string;
  tagline: string;
  subHtml: string;
  bodyHtml: string;
  headHtml?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${opts.title}</title>
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONT}" rel="stylesheet">
<link rel="stylesheet" href="${DS_CSS}">
${opts.headHtml ?? ""}
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <span class="reg">Ishtar · by Atelier G&ouml;khan Turhan</span>
    <button class="toggle" onclick="tt()" aria-label="Toggle light or dark theme">&#9685; theme</button>
  </div>
  <div class="docstrip">
    <span><span class="tick">&#9646;</span>&nbsp; ${opts.docline}</span>
    <span class="live-tag"><span class="dot"></span> Adult-only · chaperoned</span>
  </div>
  <header style="padding:2.4rem 0 0;">
    <div class="partno">${opts.partno}</div>
    <h1 class="mark" style="font-size:clamp(2rem,7vw,3rem);">ISHTAR<span class="hx">&hearts;</span></h1>
    <p class="tag">${opts.tagline}</p>
    <p class="sub">${opts.subHtml}</p>
    ${opts.bodyHtml}
  </header>
  <div class="stripe"></div>
  <footer>
    <div class="imprint">
      <span>Atelier G&ouml;khan Turhan · made by machines · adult-only (18+)</span>
      <span><a href="https://ishtar.numetal.xyz/">ishtar.numetal.xyz &#8599;</a></span>
    </div>
  </footer>
</div>
${THEME_SCRIPT}
</body>
</html>`;
}

/** GEO-BLOCK — calm, no denylist details. Mirrors the JSON `{error}` a client would get. */
export function geoBlockPage(): string {
  return datasheet({
    title: "Ishtar · unavailable in your region",
    docline: "Doc · Ishtar · Access notice · Region",
    partno: "Part No. ISH-451 — region notice",
    bodyHtml: `
    <p class="tag">Ishtar isn't available in your region.</p>
    <p class="sub">Access to the venue is restricted where you are right now, so we can't open the door. This is a venue-wide policy decision, not anything about you. If you believe this is a mistake, reach the studio below.</p>
    <div class="actions">
      <a class="btn" href="https://ishtar.numetal.xyz/docs/">Read the docs &#8599;</a>
      <a class="link-pink" href="https://x.com/goekhan">Contact the studio &#8599;</a>
    </div>`,
  });
}

/** 404 — "no such room", in the venue's voice. */
export function notFoundPage(): string {
  return datasheet({
    title: "Ishtar · no such room (404)",
    docline: "Doc · Ishtar · Not found · 404",
    partno: "Part No. ISH-404 — no such room",
    bodyHtml: `
    <p class="tag">No such room.</p>
    <p class="sub">There's nothing at this address. The link may be stale, or the room was never opened. The public surfaces are the talk page and the docs.</p>
    <div class="actions">
      <a class="btn primary" href="https://ishtar.numetal.xyz/talk/">&#9670; Talk to Ishtar</a>
      <a class="btn" href="https://ishtar.numetal.xyz/">Front door &#8599;</a>
      <a class="link-pink" href="https://ishtar.numetal.xyz/docs/">Docs &#8599;</a>
    </div>`,
  });
}

/** 500 — generic, no stack trace; same calm register. */
export function serverErrorPage(): string {
  return datasheet({
    title: "Ishtar · something broke (500)",
    docline: "Doc · Ishtar · Internal fault · 500",
    partno: "Part No. ISH-500 — internal fault",
    bodyHtml: `
    <p class="tag">Something broke on our end.</p>
    <p class="sub">The venue hit an internal fault handling this request. Nothing you did caused it. The fault is logged; please try again in a moment.</p>
    <div class="actions">
      <a class="btn" href="https://ishtar.numetal.xyz/">Front door &#8599;</a>
      <a class="link-pink" href="https://ishtar.numetal.xyz/docs/">Docs &#8599;</a>
    </div>`,
  });
}
