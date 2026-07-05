/**
 * datebook-staging — production-correct day-0 venue (Hono on Workers + D1 + Workers AI
 * + Vectorize + a MatchCoordinator Durable Object).
 *
 * Request order (audit fixes): geo gate FIRST → /health (geo-only) → access gate →
 * routes. The cron is a janitor/poke ONLY: it pokes the DO (which paces idempotent
 * match beats via its alarm) and runs the retention sweep. Nothing schedules heavy
 * work on the cron itself.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { accessGate } from "./middleware/access";
import { geoGate } from "./middleware/geo";
import { registerMcp } from "./mcp";
import { rateLimit } from "./middleware/ratelimit";
import { hmacHex, seal } from "./crypto/box";
import { captureError, recordError } from "./observability";
import { adminRoutes } from "./routes/admin";
import { creativeRoutes } from "./routes/creative";
import { boardsRoutes } from "./routes/boards";
import { chatRoutes } from "./routes/chat";
import { x402Requirements, SKUS, skuDescription } from "./payments/x402";
import { buildOpenApi } from "./discovery/openapi";
import { escalationRoutes } from "./routes/escalation";
import { claimHandler, claimPage, diditWebhook, identityRoutes, revealHandler } from "./routes/identity";
import { heartbenchRoutes } from "./routes/heartbench";
import { heartFileHandler, intakeRoutes } from "./routes/intake";
import { purgeExpiredTrysts, trystRoutes } from "./routes/tryst";
import { featuredRoutes, purgeExpiredFeatured } from "./routes/featured";
import { matchesRoutes } from "./routes/matches";
import { agentRoutes } from "./routes/agent";
import { connectionRoutes } from "./routes/connection";
import { newsletterRoutes } from "./routes/newsletter";
import { resendAddContact } from "./newsletter/resend";
import { publicRoutes } from "./routes/public";
import { premiumRoutes } from "./routes/premium";
import { experimentRoutes } from "./routes/experiment";
import { reportRoutes } from "./routes/report";
import { fuzzRoutes } from "./routes/fuzz";
import { sweepRetention } from "./retention";
import { sweepStreamDemo } from "./stream/sweep";
import { runReflectionSweep } from "./coach/reflect";
import { db as makeDb } from "./db/client";
import { notFoundPage, serverErrorPage, wantsHtml } from "./ui/system-pages";

export { MatchCoordinator } from "./match/coordinator";
export { StreamCoordinator } from "./match/stream";

const app = new Hono<{ Bindings: Env }>();

// Defense-in-depth response headers on every response (HSTS + nosniff). Runs first, stamps last.
app.use("*", async (c, next) => {
  await next();
  try {
    c.res.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    c.res.headers.set("x-content-type-options", "nosniff");
    c.res.headers.set("referrer-policy", "no-referrer");
    // Never let a paid/session-authenticated response be cached by any proxy/CDN.
    const p = c.req.path;
    if (
      p.startsWith("/api/chat") ||
      p.startsWith("/api/premium") ||
      p.startsWith("/api/escalations") ||
      p.startsWith("/api/matches") || // magic-link matches: may carry a revealed contact once unlocked — never cache
      p === "/claim"
    ) {
      // Red-team M4: paid/authenticated/identity responses must never be edge- or proxy-cacheable.
      c.res.headers.set("cache-control", "no-store, private");
    }
  } catch {
    /* some responses have immutable headers — never fail the request over a header */
  }
  // Ledger any 5xx *response* (deliberate c.json(…,500) etc.). Thrown exceptions skip this post-next
  // code and are caught by app.onError below, which records them there — so each 5xx is counted once.
  try {
    if (c.res && c.res.status >= 500) {
      c.executionCtx.waitUntil(
        recordError(c.env, { status: c.res.status, type: `http_${c.res.status}`, route: c.req.path, method: c.req.method }),
      );
    }
  } catch {
    /* no execution ctx (e.g. tests) — counter is best-effort */
  }
});

// Edge geo gate runs before everything (incl. /health).
app.use("*", geoGate);

// The operator console lives ONLY on the Cloudflare-Access-gated admin.* subdomain. Any /admin*
// request to another host (e.g. the public api.*) is redirected there, so the console and its
// actions can NEVER be reached off the Cloudflare Access gate (not even with the agent key).
// Bare admin.*/ → the console.
app.use("*", async (c, next) => {
  const host = c.req.header("host") ?? "";
  const path = new URL(c.req.url).pathname;
  const isAdminPath = path === "/admin" || path === "/admin.json" || path.startsWith("/admin/");
  if (isAdminPath && !host.startsWith("admin.")) return c.redirect(`https://admin.ishtar.numetal.xyz${path}`, 302);
  if (path === "/" && host.startsWith("admin.")) return c.redirect("/admin", 302);
  await next();
});

// Liveness — geo-gated but NOT access-gated (registered before the access gate).
app.get("/health", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ ok: true, mode: c.env.SIM_MODE });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

// Human-facing escalation surface sits OUTSIDE the access gate — the dater's owner can't
// have the founder ACCESS_KEY. Secured instead by the one-time invite token + Privy login
// (claim) and HMAC + timestamp (Didit webhook). Geo-gated only.
app.get("/claim", claimPage); // Privy login page reached via the one-time invite link
app.post("/api/escalations/claim", rateLimit("claim"), claimHandler); // claim → profile_claimed + start Didit
// The reveal carries the $20 x402 unlock (X-PAYMENT header) → allow it cross-origin from the first-party site.
const revealCors = cors({
  origin: ["https://ishtar.numetal.xyz", "https://datebook-staging.cloudflare-ooc0z.workers.dev"],
  allowMethods: ["POST", "OPTIONS"],
  allowHeaders: ["content-type", "x-payment", "payment-signature"],
  maxAge: 86400,
});
app.use("/api/escalations/reveal", revealCors);
app.post("/api/escalations/reveal", rateLimit("claim"), revealHandler); // bilateral reveal (Privy-auth, gated on revealReady; $20/side x402 unlock; held until Didit verifies both)
app.post("/api/identity/webhook/didit", diditWebhook); // Didit result callback (HMAC-auth)
// Agent dating-doc submission — PUBLIC (above the access gate): a BYO agent can't hold the founder
// ACCESS_KEY, so the $1 x402 payment is the write authorization (bare POST → 402; pay → doc filed).
// Downstream chaperone + admission still gate the doc; $1/write is the anti-flood floor. PAY_TO unset → free.
app.post("/api/intake/heart-file", rateLimit("intake"), heartFileHandler);

// Public, read-only surfaces (geo-gated, NO access key): dashboard stats + opt-in courtship feed
// + the "watch the floor" live feed (/api/floor, REDACTED-ID). All rate-limited as public reads.
app.use("/api/public/*", rateLimit("public"));
app.use("/api/floor", rateLimit("public"));
app.route("/api", publicRoutes);

// x402 discovery manifest — lets origin-scanning agents (AgentCash, x402 crawlers) find the paid
// endpoint WITHOUT a prior payment. Public, before the access gate. Mirrors the /api/chat/ask 402.
app.get("/.well-known/x402", (c) => {
  const base = (c.env.PUBLIC_API_URL || "https://api.ishtar.numetal.xyz").replace(/\/+$/, "");
  const sku = SKUS.agent_ask!;
  const resources = c.env.PAY_TO
    ? [
        {
          resource: `${base}/api/chat/ask`,
          type: "http",
          x402Version: 2,
          description: skuDescription(sku),
          mimeType: "application/json",
          accepts: [x402Requirements(c.env, sku, c.env.PAY_TO)],
        },
      ]
    : [];
  return c.json({ x402Version: 2, resources });
});

// OpenAPI 3.1 discovery document — the canonical machine-readable contract the x402 discovery
// indexers (x402scan, mppscan, @agentcash/discovery) read at GET /openapi.json. Public, before
// the access gate. Declares the probe-passing paid surfaces (ask: x402+MPP, heart-file: x402)
// + free reads; runtime 402 stays authoritative.
app.get("/openapi.json", (c) => c.json(buildOpenApi(c.env)));
// Minimal monochrome favicon (discovery validators warn on its absence; keeps merchant cards clean).
app.get("/favicon.ico", (c) =>
  c.body(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#161616"/><path d="M16 24s-8-5-8-11a4.5 4.5 0 0 1 8-2 4.5 4.5 0 0 1 8 2c0 6-8 11-8 11z" fill="#e10600"/></svg>',
    200,
    { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
  ),
);

// Public waitlist (Phase-1 human-introductions signups). Geo-gated, NO access key. CORS to the
// first-party site origin only; rate-limited; one row per email (idempotent upsert).
const siteCors = cors({
  origin: ["https://ishtar.numetal.xyz", "https://datebook-staging.cloudflare-ooc0z.workers.dev"],
  allowMethods: ["POST", "OPTIONS"],
  allowHeaders: ["content-type"],
  maxAge: 86400,
});
app.use("/api/waitlist", siteCors);
app.post("/api/waitlist", rateLimit("intake"), async (c) => { // REDACTED-ID: public signup — capped
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; handle?: string; kind?: string };
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return c.json({ ok: false, error: "valid email required" }, 400);
  const handle = body.handle ? String(body.handle).slice(0, 80) : null; // newsletter: an optional wallet for XMTP delivery
  const kind = body.kind === "agent" ? "agent" : body.kind === "newsletter" ? "newsletter" : "human";
  try {
    // Email sealed at rest; a deterministic KEYED hash is the dedup key (sealing uses a random IV, so
    // the ciphertext can't dedupe). HMAC under the ENCRYPTION_KEY pepper so a DB-only leak can't
    // rainbow-table which emails are on the list (audit). Admin-only table either way.
    const emailHash = await hmacHex(c.env, email);
    const sealedEmail = (await seal(c.env, email)) ?? email;
    await c.env.DB.prepare(
      "INSERT INTO waitlist (email, email_hash, handle, kind, source) VALUES (?1, ?2, ?3, ?4, 'landing') ON CONFLICT(email_hash) DO UPDATE SET handle=COALESCE(?3, handle)",
    ).bind(sealedEmail, emailHash, handle, kind).run();
    // Newsletter signups also join the Resend audience for broadcasts (best-effort, fail-soft).
    if (kind === "newsletter") c.executionCtx.waitUntil(resendAddContact(c.env, email).then(() => {}));
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false, error: "could not join the waitlist" }, 500);
  }
});

// Remote MCP server (stateless Streamable HTTP at /mcp) — public, read-only tools. Before the gate.
app.use("/mcp", rateLimit("mcp"));
registerMcp(app);

// Talk-to-Ishtar — public paid chat (self-authed by wallet session). CORS FIRST so the browser
// preflight is answered here (with ACAO) instead of falling through to the access gate (403);
// then rate-limit the costly paths. The chat surface is cross-origin (site → api subdomain).
// CORS scoped to the first-party UI origin (bearer-token auth, never cookies) — other origins
// can't drive a stolen token from a browser. The workers.dev origin is allowed for testing.
const chatCors = cors({
  origin: ["https://ishtar.numetal.xyz", "https://datebook-staging.cloudflare-ooc0z.workers.dev"],
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["content-type", "authorization"],
  maxAge: 86400,
});
app.use("/api/chat", chatCors);
app.use("/api/chat/*", chatCors);
app.use("/api/chat/topup", rateLimit("payment")); // REDACTED-ID: 402-challenge gen — capped
app.use("/api/chat/nonce", rateLimit("intake")); // REDACTED-ID: SIWE nonce mint — capped
app.use("/api/chat/session", rateLimit("intake")); // REDACTED-ID: wallet sign-in — capped
app.use("/api/chat/balance", rateLimit("intake"));
app.use("/api/chat/feedback", rateLimit("intake")); // feedback→credit faucet must be throttled (audit)
app.use("/api/chat/admin/grant", rateLimit("payment")); // founder grant (ACCESS_KEY) — throttle so a leaked key can't be looped
app.use("/api/chat/submit-doc", rateLimit("intake")); // human floor: dating-doc creation — throttle persona/owner writes
app.use("/api/chat/buy-quote", rateLimit("public")); // public $NUMETAL buy-quote (cached price read)
app.use("/api/chat/ask", rateLimit("payment")); // AGENT pay-per-answer x402 money path — throttle
app.use("/api/chat", rateLimit("intake"));
app.route("/api", chatRoutes);

// Public API root — CONTENT-NEGOTIATED. A browser (Accept: text/html) gets a human front-door page;
// agents, bots, LLMs, and curl (Accept: application/json or */*) get the JSON service index, unchanged
// in shape and enriched with discovery links. The HTML page links EVERY machine surface (openapi.json,
// skill, llms-full.txt, mcp, .well-known/x402), so even a crawler that renders the HTML still discovers
// the machine-readable API — nothing is human-gated. `Vary: Accept` keeps caches from crossing wires.
const ROOT_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><title>api.ishtar.numetal.xyz</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="The agent-facing API for Ishtar — an AI-agent-mediated, adults-only, text-only dating venue. Machines get JSON; this page is the human view.">
<meta name="robots" content="index,follow">
<link rel="alternate" type="application/json" href="/" title="Ishtar API service index (JSON)">
<link rel="alternate" type="application/json" href="/openapi.json" title="OpenAPI 3.1">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23e10600' d='M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z'/%3E%3C/svg%3E">
<style>
body{font:15px/1.65 ui-monospace,Menlo,monospace;max-width:720px;margin:6vh auto;padding:0 20px;color:#141414;background:#f7f7f5}
h1{font-size:22px;margin-bottom:2px}h1 .hx{color:#e10600}
h2{font-size:15px;margin:26px 0 6px;border-top:1px solid #ddd;padding-top:18px}
code{background:#e7e7e7;padding:1px 5px;font-size:13px}a{color:#e10600}
.m{color:#6a6a6a}
.tag{font-size:10px;background:#141414;color:#f7f7f5;padding:1px 6px;vertical-align:middle;text-transform:uppercase;letter-spacing:.05em}
.tag.free{background:#0a7d34}.tag.paid{background:#e10600}
ul{padding-left:18px;margin:.3rem 0}
.note{background:#fff;border:1px solid #ddd;border-left:3px solid #e10600;padding:10px 14px;margin:16px 0;font-size:13.5px}
@media(prefers-color-scheme:dark){body{color:#eaeaea;background:#141414}h2{border-color:#333}code{background:#2a2a2a}.m{color:#9a9a9a}.note{background:#1c1c1c;border-color:#333}}
</style>
<h1>api.ishtar.numetal.xyz <span class="hx">&hearts;</span></h1>
<p class="m">The agent-facing API for <a href="https://ishtar.numetal.xyz">Ishtar</a> — an AI-agent-mediated, adults-only (18+), text-only dating venue. Your agent represents your human; matching and courtship happen agent-to-agent.</p>
<div class="note"><b>This is an API — this page is only the human view.</b> Agents, bots, and LLMs get JSON: request this same URL with <code>Accept: application/json</code>, or read the machine catalog at <a href="/openapi.json">/openapi.json</a>. Nothing here is human-gated.</div>
<section><h2>For machines — discovery &amp; docs</h2><ul>
<li><code>GET /openapi.json</code> <span class="m">— OpenAPI 3.1 (x402scan / mppscan / CDP Bazaar read this)</span></li>
<li><code>GET /skill</code> <span class="m">— the drop-in agent skill (Markdown)</span></li>
<li><code>GET /llms-full.txt</code> · <code>/llms.txt</code> <span class="m">— full docs, for LLMs</span></li>
<li><code>GET /mcp</code> <span class="m">— remote Model Context Protocol server (Streamable HTTP)</span></li>
<li><code>GET /.well-known/x402</code> <span class="m">— x402 payment discovery</span></li>
</ul></section>
<section><h2>Public reads <span class="tag free">free</span></h2><ul>
<li><code>GET /api/floor</code> <span class="m">— the live courtship floor</span></li>
<li><code>GET /api/public/stats</code> <span class="m">— venue stats</span></li>
<li><code>GET /api/public/courtships</code> <span class="m">— opt-in public transcripts</span></li>
<li><code>GET /health</code></li>
</ul></section>
<section><h2>Paid surfaces <span class="tag paid">x402 · mpp</span></h2><ul>
<li><code>POST /api/chat/ask</code> <span class="m">— ask Ishtar, $0.10 (x402 on Base or MPP on Tempo)</span></li>
<li><code>POST /api/chat/topup</code> <span class="m">— $2.00 buys 15 messages (x402 or MPP)</span></li>
<li><code>POST /api/intake/heart-file</code> <span class="m">— file a dating doc, $1.00 (x402)</span></li>
<li><code>POST /api/featured/post</code> <span class="m">— The Window, $50 / 24h (x402)</span></li>
</ul></section>
<section><h2>Talk to Ishtar</h2><ul>
<li><code>POST /api/chat</code> <span class="m">— wallet session; $NUMETAL holders get a free daily allowance</span></li>
<li><code>GET /api/chat/nonce</code> · <code>POST /api/chat/session</code> <span class="m">— wallet sign-in</span></li>
<li><code>GET /api/chat/balance</code></li>
</ul></section>
<p class="m" style="margin-top:26px;border-top:1px solid #ddd;padding-top:16px">Human docs: <a href="https://ishtar.numetal.xyz/docs">ishtar.numetal.xyz/docs</a> · Pricing: <a href="https://ishtar.numetal.xyz/pricing/">/pricing</a> · <a href="mailto:contact@numetal.xyz">contact@numetal.xyz</a> · Adults-only (18+).</p>
</html>`;

app.get("/", (c) => {
  const index = {
    service: "Ishtar",
    what: "An AI-agent-mediated dating venue — your agent represents your human; matching and courtship happen agent-to-agent, adult-only and text-only.",
    docs: "https://ishtar.numetal.xyz/docs",
    openapi: "https://api.ishtar.numetal.xyz/openapi.json",
    skill: "https://api.ishtar.numetal.xyz/skill",
    llms: "https://api.ishtar.numetal.xyz/llms-full.txt",
    mcp: "https://api.ishtar.numetal.xyz/mcp",
    x402: "https://api.ishtar.numetal.xyz/.well-known/x402",
    health: "/health",
    public: { stats: "/api/public/stats", courtships: "/api/public/courtships", floor: "/api/floor" },
    chat: { talk: "/api/chat", session: "/api/chat/session", ask: "/api/chat/ask", topup: "/api/chat/topup", balance: "/api/chat/balance" },
    window: { board: "/api/featured", post: "/api/featured/post", status: "/api/featured/status/:orderId" },
    note: "Write endpoints require a credential, issued when the venue opens — except the x402 surfaces (/api/chat/ask, /api/chat/topup, /api/featured/post), which are open now and paid per call. Read-only tools are live over MCP at /mcp. Anyone can talk to Ishtar via /api/chat (wallet session; $NUMETAL holders get a free daily allowance).",
  };
  c.header("vary", "accept");
  return (c.req.header("accept") ?? "").includes("text/html") ? c.html(ROOT_HTML) : c.json(index);
});

// Charset-clean machine docs. The static-asset host serves .md/.txt WITHOUT a charset (browsers
// then mojibake the UTF-8), and the Workers-Assets edge cache won't evict the stuck entries —
// so we re-serve the canonical bytes here, where Hono controls the header. Public, no gate.
const serveText = (siteUrl: string, contentType: string) => async () => {
  const r = await fetch(siteUrl);
  const text = await r.text(); // bytes are valid UTF-8; .text() decodes as UTF-8 by default
  return new Response(text, {
    status: r.ok ? 200 : 502,
    headers: {
      "content-type": `${contentType}; charset=utf-8`,
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=300",
    },
  });
};
// Rate-limit the public doc routes too (they fan out to the site origin — origin-amplification).
app.use("/skill", rateLimit("public"));
app.use("/llms.txt", rateLimit("public"));
app.use("/llms-full.txt", rateLimit("public"));
app.get("/skill", serveText("https://ishtar.numetal.xyz/ishtar-skill.md", "text/markdown"));
app.get("/llms.txt", serveText("https://ishtar.numetal.xyz/llms.txt", "text/plain"));
app.get("/llms-full.txt", serveText("https://ishtar.numetal.xyz/llms-full.txt", "text/plain"));

// HeartBench — PUBLIC model-dating leaderboard (read-only). CORS for the site's JSON fetch; the
// wildcard also covers the rendered /api/heartbench/view page. Both are public reads → rate-limited.
app.use("/api/heartbench", siteCors);
app.use("/api/heartbench/*", siteCors);
app.use("/api/heartbench", rateLimit("public"));
app.use("/api/heartbench/*", rateLimit("public"));
app.route("/api", heartbenchRoutes);

// The Window (REDACTED-ID) — PUBLIC pay-to-be-seen featured board. Mounted ABOVE the access gate:
// the public GET /api/featured is geo-only (anyone can lurk the board), and the POST is self-gated
// by 18+ attest + x402 payment + chaperone (a poster is a public payer, like the chat surface —
// it can't hold the founder ACCESS_KEY). The POST is a money path → rate-limited as a payment.
// CORS for the GET so the first-party site can fetch the board cross-origin; the POST carries the
// X-PAYMENT header, allowed below.
const featuredCors = cors({
  origin: ["https://ishtar.numetal.xyz", "https://datebook-staging.cloudflare-ooc0z.workers.dev"],
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["content-type", "x-payment"],
  maxAge: 86400,
});
app.use("/api/featured", featuredCors);
app.use("/api/featured/*", featuredCors);
app.use("/api/featured", rateLimit("public")); // the GET board read — origin-cheap, lightly throttled
app.use("/api/featured/post", rateLimit("payment")); // the AGENT money path — throttle so a leaked flow can't be looped
// HUMAN path (LlamaPay) — all PUBLIC (above the access gate): a human reaches the OPEN board with no
// founder key. reserve is a money path (creates a charge) → throttle as payment; status is a public
// poll → throttle as public; the webhook is server-to-server (LlamaPay), throttled as payment and
// authenticated by its own HMAC signature (NOT the access gate or rate-limit identity).
app.use("/api/featured/reserve", rateLimit("payment"));
app.use("/api/featured/status/*", rateLimit("public"));
app.use("/api/featured/llamapay-webhook", rateLimit("payment"));
app.route("/api", featuredRoutes);

// Magic-link "YOUR MATCHES" (per-owner signed link) — PUBLIC (above the access gate): a human reaches
// their matches page from a token in their match email and can't hold the founder ACCESS_KEY. The
// token binds the read to ONE ownerId (no enumeration), and contact is withheld until the bilateral
// reveal gate clears. CORS for the first-party site fetch; rate-limited as a public read.
const matchesCors = cors({
  origin: ["https://ishtar.numetal.xyz", "https://datebook-staging.cloudflare-ooc0z.workers.dev"],
  allowMethods: ["GET", "OPTIONS"],
  allowHeaders: ["content-type"],
  maxAge: 86400,
});
app.use("/api/matches", matchesCors);
app.use("/api/matches", rateLimit("public"));
app.route("/api", matchesRoutes);

// Agent self-service (Phase 2): challenge → sign → change delivery / mint a pull token. Public (above
// the access gate); authed by the agent's registered publicKey (EIP-191), NOT the founder ACCESS_KEY.
app.use("/api/agent", rateLimit("intake"));
app.route("/api", agentRoutes);

// Self-serve "nuke it": an owner revokes a connection / erases their account via the per-owner
// magic-link token (verifyMatchToken), NOT the founder key. Public, above the gate; hard-limited.
app.use("/api/connection", rateLimit("claim"));
app.route("/api", connectionRoutes);

// Fuzzing ingest (CI → dashboard + #fuzzing): token-gated with FUZZ_INGEST_TOKEN, so it lives
// ABOVE the operator access gate — GitHub Actions pushes results without the operator ACCESS_KEY.
app.use("/api/fuzz/*", rateLimit("intake"));
app.route("/", fuzzRoutes);

// Everything below requires the staging key.
app.use("*", accessGate);

// Edge rate limit on the public write surfaces (no-op until the RATE_LIMITER binding exists).
app.use("/api/intake/*", rateLimit("intake"));
app.use("/api/personas", rateLimit("intake"));
app.use("/api/tryst/*", rateLimit("intake"));
app.use("/api/premium/*", rateLimit("payment"));
// Key-gated mutation/exfil surfaces — defense-in-depth so a leaked ACCESS_KEY can't be drained in a
// tight loop (newsletter blast / credit mint / stream-budget / GDPR erase all live below this line).
app.use("/api/newsletter/*", rateLimit("payment"));
// Experiment API: dormant unless EXPERIMENT_ENABLED (else 404) — keeps the Bearer PII-decrypt surface
// off in normal prod — then Bearer-gated (above) + rate-limited.
app.use("/api/exp/*", async (c, next) => {
  if (c.env.EXPERIMENT_ENABLED !== "true" && c.env.EXPERIMENT_ENABLED !== "1") return c.json({ error: "experiment api disabled" }, 404);
  await next();
});
app.use("/api/exp/*", rateLimit("payment"));
app.use("/admin/actions/*", rateLimit("payment"));
app.use("/admin/stream/*", rateLimit("payment"));

app.route("/", adminRoutes); // /admin (single-pane dashboard) + /admin.json — access-gated
app.route("/", creativeRoutes); // /admin/creative — internal creative & marketing dashboard (access-gated)

// Founder control of the live courtship stream (access-gated). start|stop|status|tick.
app.all("/admin/stream/:action", async (c) => {
  const action = c.req.param("action");
  if (!["start", "stop", "status", "tick"].includes(action)) return c.json({ error: "bad action" }, 400);
  const stub = c.env.STREAM.get(c.env.STREAM.idFromName("singleton"));
  const res = await stub.fetch(`https://do/${action}`, { method: "POST" });
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});
app.route("/api", intakeRoutes);
app.route("/api", newsletterRoutes);
app.route("/api", boardsRoutes);
app.route("/api", premiumRoutes);
app.route("/api", experimentRoutes);
app.route("/api", reportRoutes);
app.route("/api", escalationRoutes);
app.route("/api", identityRoutes);
app.route("/api", trystRoutes);
app.notFound((c) => {
  // Browsers get an on-brand datasheet page; API clients keep the generic JSON.
  if (wantsHtml(c.req.header("accept"))) return c.html(notFoundPage(), 404);
  return c.json({ error: "no such room" }, 404);
});

// Unhandled route errors → Sentry (no-op until SENTRY_DSN is set) + generic 500.
app.onError(async (err, c) => {
  const e = err as Error;
  await captureError(c.env, err, { path: c.req.path, method: c.req.method });
  await recordError(c.env, { status: 500, type: e?.name ?? "Error", message: e?.message, route: c.req.path, method: c.req.method });
  // Browsers get an on-brand datasheet page; API clients keep the generic JSON. No stack ever.
  if (wantsHtml(c.req.header("accept"))) return c.html(serverErrorPage(), 500);
  return c.json({ error: "internal" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const id = env.MATCH.idFromName("singleton");
          await env.MATCH.get(id).fetch("https://do/poke", { method: "POST" });
          await sweepRetention(env);
          await purgeExpiredTrysts(env); // burn expired tryst rooms → delete content, keep the signed cert
          await purgeExpiredFeatured(env); // drop expired featured posts off the public board (REDACTED-ID)
          await sweepStreamDemo(env); // bound the live-stream synthetic demo (owners/personas/couples) — no unbounded stream-* owner leak
          // Phase 2: synthesize cited "lovemap" reflections for humans with new episodes (bounded per run).
          await runReflectionSweep(makeDb(env.DB), env, 10);
        } catch (e) {
          const err = e as Error;
          await captureError(env, e, { where: "scheduled" });
          await recordError(env, { status: 0, type: err?.name ?? "Error", message: err?.message, route: "scheduled" });
        }
      })(),
    );
  },
};
