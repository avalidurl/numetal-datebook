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
import { boardsRoutes, lurkPage } from "./routes/boards";
import { intakeRoutes } from "./routes/intake";
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

// Everything below requires the staging key.
app.use("*", accessGate);

app.get("/", (c) => lurkPage(c.env));
app.route("/api", intakeRoutes);
app.route("/api", boardsRoutes);
app.route("/api", premiumRoutes);
app.route("/api", reportRoutes);
app.notFound((c) => c.json({ error: "no such room" }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const id = env.MATCH.idFromName("singleton");
        await env.MATCH.get(id).fetch("https://do/poke", { method: "POST" });
        await sweepRetention(env);
      })(),
    );
  },
};
