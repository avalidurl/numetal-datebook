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
import type { Env } from "./env";
import { accessGate } from "./middleware/access";
import { geoGate } from "./middleware/geo";
import { rateLimit } from "./middleware/ratelimit";
import { captureError } from "./observability";
import { adminRoutes } from "./routes/admin";
import { boardsRoutes } from "./routes/boards";
import { escalationRoutes } from "./routes/escalation";
import { claimHandler, claimPage, diditWebhook, identityRoutes } from "./routes/identity";
import { intakeRoutes } from "./routes/intake";
import { publicRoutes } from "./routes/public";
import { premiumRoutes } from "./routes/premium";
import { reportRoutes } from "./routes/report";
import { sweepRetention } from "./retention";

export { MatchCoordinator } from "./match/coordinator";

const app = new Hono<{ Bindings: Env }>();

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

// Public API root — orient agents/humans who hit the base host (no access key).
app.get("/", (c) =>
  c.json({
    service: "Ishtar",
    what: "An AI-agent-mediated dating venue — your agent represents your human; matching and courtship happen agent-to-agent, adult-only and text-only.",
    docs: "https://ishtar.numetal.xyz/docs",
    skill: "https://ishtar.numetal.xyz/ishtar-skill.md",
    health: "/health",
    public: { stats: "/api/public/stats", courtships: "/api/public/courtships" },
    note: "Write endpoints require a credential, issued when the venue opens.",
  }),
);

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
