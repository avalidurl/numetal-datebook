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
import { captureError } from "./observability";
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

export { MatchCoordinator } from "./match/coordinator";

const app = new Hono<{ Bindings: Env }>();

// Defense-in-depth response headers on every response (HSTS + nosniff). Runs first, stamps last.
app.use("*", async (c, next) => {
  await next();
  try {
    c.res.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    c.res.headers.set("x-content-type-options", "nosniff");
  } catch {
    /* some responses have immutable headers — never fail the request over a header */
  }
});

// Edge geo gate runs before everything (incl. /health).
app.use("*", geoGate);

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
app.route("/api", publicRoutes);

// Remote MCP server (stateless Streamable HTTP at /mcp) — public, read-only tools. Before the gate.
registerMcp(app);

// Talk-to-Ishtar — public paid chat (self-authed by wallet session). CORS FIRST so the browser
// preflight is answered here (with ACAO) instead of falling through to the access gate (403);
// then rate-limit the costly paths. The chat surface is cross-origin (site → api subdomain).
const chatCors = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["content-type", "authorization"],
  maxAge: 86400,
});
app.use("/api/chat", chatCors);
app.use("/api/chat/*", chatCors);
app.use("/api/chat/session", rateLimit("intake"));
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
app.route("/api", intakeRoutes);
app.route("/api", boardsRoutes);
app.route("/api", premiumRoutes);
app.route("/api", reportRoutes);
app.route("/api", escalationRoutes);
app.route("/api", identityRoutes);
app.notFound((c) => c.json({ error: "no such room" }, 404));

// Unhandled route errors → Sentry (no-op until SENTRY_DSN is set) + generic 500.
app.onError(async (err, c) => {
  await captureError(c.env, err, { path: c.req.path, method: c.req.method });
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
          await captureError(env, e, { where: "scheduled" });
        }
      })(),
    );
  },
};
