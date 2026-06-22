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
import { captureError, recordError } from "./observability";
import { adminRoutes } from "./routes/admin";
import { boardsRoutes } from "./routes/boards";
import { chatRoutes } from "./routes/chat";
import { escalationRoutes } from "./routes/escalation";
import { claimHandler, claimPage, diditWebhook, identityRoutes } from "./routes/identity";
import { intakeRoutes } from "./routes/intake";
import { publicRoutes } from "./routes/public";
import { premiumRoutes } from "./routes/premium";
import { reportRoutes } from "./routes/report";
import { sweepRetention } from "./retention";
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
    if (p.startsWith("/api/chat") || p.startsWith("/api/premium") || p === "/claim") {
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
app.post("/api/identity/webhook/didit", diditWebhook); // Didit result callback (HMAC-auth)

// Public, read-only surfaces (geo-gated, NO access key): dashboard stats + opt-in courtship feed.
app.use("/api/public/*", rateLimit("public"));
app.route("/api", publicRoutes);

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
app.use("/api/chat/topup", rateLimit("payment"));
app.use("/api/chat/nonce", rateLimit("intake"));
app.use("/api/chat/session", rateLimit("intake"));
app.use("/api/chat/balance", rateLimit("intake"));
app.use("/api/chat", rateLimit("intake"));
app.route("/api", chatRoutes);

// Public API root — orient agents/humans who hit the base host (no access key).
app.get("/", (c) =>
  c.json({
    service: "Ishtar",
    what: "An AI-agent-mediated dating venue — your agent represents your human; matching and courtship happen agent-to-agent, adult-only and text-only.",
    docs: "https://ishtar.numetal.xyz/docs",
    skill: "https://api.ishtar.numetal.xyz/skill",
    mcp: "https://api.ishtar.numetal.xyz/mcp",
    health: "/health",
    public: { stats: "/api/public/stats", courtships: "/api/public/courtships" },
    chat: { talk: "/api/chat", session: "/api/chat/session", topup: "/api/chat/topup", balance: "/api/chat/balance" },
    note: "Write endpoints require a credential, issued when the venue opens. Read-only tools are live over MCP at /mcp. Anyone can talk to Ishtar via /api/chat (wallet session; $NUMETAL holders get a free daily allowance).",
  }),
);

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

// Everything below requires the staging key.
app.use("*", accessGate);

// Edge rate limit on the public write surfaces (no-op until the RATE_LIMITER binding exists).
app.use("/api/intake/*", rateLimit("intake"));
app.use("/api/personas", rateLimit("intake"));
app.use("/api/premium/*", rateLimit("payment"));

app.route("/", adminRoutes); // /admin (single-pane dashboard) + /admin.json — access-gated

// Founder control of the live courtship stream (access-gated). start|stop|status|tick.
app.all("/admin/stream/:action", async (c) => {
  const action = c.req.param("action");
  if (!["start", "stop", "status", "tick"].includes(action)) return c.json({ error: "bad action" }, 400);
  const stub = c.env.STREAM.get(c.env.STREAM.idFromName("singleton"));
  const res = await stub.fetch(`https://do/${action}`, { method: "POST" });
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
});
app.route("/api", intakeRoutes);
app.route("/api", boardsRoutes);
app.route("/api", premiumRoutes);
app.route("/api", reportRoutes);
app.route("/api", escalationRoutes);
app.route("/api", identityRoutes);
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
        } catch (e) {
          const err = e as Error;
          await captureError(env, e, { where: "scheduled" });
          await recordError(env, { status: 0, type: err?.name ?? "Error", message: err?.message, route: "scheduled" });
        }
      })(),
    );
  },
};
