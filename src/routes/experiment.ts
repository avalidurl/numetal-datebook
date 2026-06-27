/**
 * Experiment operator API — Bearer(ACCESS_KEY)-gated on the public api.* host, the same trust level
 * as /api/chat/admin/grant. The HTML operator console lives on the CF-Access-only admin.* host and
 * cannot take a Bearer; these endpoints give the operator key a machine-drivable path to run a
 * controlled two-agent dating experiment (force a pair, drive the courtship, comp the reports, record
 * notes) and to READ the resulting couple dossier as JSON. Mounted after the global access gate.
 */
import { Hono } from "hono";
import { open } from "../crypto/box";
import type { Env } from "../env";

export const experimentRoutes = new Hono<{ Bindings: Env }>();

const tryParse = (s: string | null): unknown => {
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

// Comp specific owners' compatibility reports at runtime (sets the `x402_free_owners` setting).
experimentRoutes.post("/exp/comp", async (c) => {
  const { value } = (await c.req.json().catch(() => ({}))) as { value?: string };
  if (!value) return c.json({ ok: false, error: "value (comma-separated owner ids) required" }, 400);
  await c.env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('x402_free_owners', ?1) ON CONFLICT(key) DO UPDATE SET value=?1, updated_at=datetime('now')",
  )
    .bind(String(value))
    .run();
  return c.json({ ok: true, x402_free_owners: String(value) });
});

// Force a couple between two named admitted personas + seed Ishtar's grounded gambit.
experimentRoutes.post("/exp/pair", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { aPersonaId?: number; bPersonaId?: number };
  const a = Number(b.aPersonaId);
  const bb = Number(b.bPersonaId);
  if (!Number.isInteger(a) || !Number.isInteger(bb) || a <= 0 || bb <= 0) return c.json({ ok: false, error: "aPersonaId + bPersonaId required" }, 400);
  const id = c.env.MATCH.idFromName("singleton");
  const r = await c.env.MATCH.get(id).fetch(`https://do/pair?a=${a}&b=${bb}`, { method: "POST" });
  return c.json(await r.json());
});

// Advance a named couple by up to `turns` chaperoned courtship lines.
experimentRoutes.post("/exp/court", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { coupleId?: number; turns?: number };
  const id = Number(b.coupleId);
  if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: "coupleId required" }, 400);
  const n = Math.min(Math.max(Number(b.turns) || 12, 1), 20);
  const stub = c.env.STREAM.get(c.env.STREAM.idFromName("singleton"));
  const steps: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const r = await stub.fetch(`https://do/court?coupleId=${id}`, { method: "POST" });
    const j = (await r.json()) as Record<string, unknown>;
    steps.push(j);
    if (j.maxed || j.error || j.withheld) break;
  }
  return c.json({ ok: true, coupleId: id, steps });
});

// Record an experiment note (e.g. experiment_reasoning / experiment_report) as an events row.
experimentRoutes.post("/exp/note", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { kind?: string; payload?: unknown };
  const kind = String(b.kind || "").slice(0, 40);
  if (!kind) return c.json({ ok: false, error: "kind required" }, 400);
  await c.env.DB.prepare("INSERT INTO events (kind, payload) VALUES (?1, ?2)").bind(kind, JSON.stringify(b.payload ?? {})).run();
  return c.json({ ok: true });
});

// JSON couple dossier (decrypted) — the machine-readable twin of the admin HTML couple view.
experimentRoutes.get("/exp/couple/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad couple id" }, 400);
  const env = c.env;
  const cp = (await env.DB.prepare(
    `SELECT c.id, c.state, c.match_score, c.turn_count, c.rationale, c.a_id, c.b_id,
            pa.handle a_handle, pa.owner_id a_owner, pa.model a_model, pa.heart_json a_heart,
            pb.handle b_handle, pb.owner_id b_owner, pb.model b_model, pb.heart_json b_heart
     FROM couples c LEFT JOIN personas pa ON pa.id=c.a_id LEFT JOIN personas pb ON pb.id=c.b_id WHERE c.id=?1`,
  )
    .bind(id)
    .first()) as Record<string, unknown> | null;
  if (!cp) return c.json({ error: "no such couple" }, 404);
  const turns = ((await env.DB.prepare("SELECT turn_seq, author_id, author_kind, body, status FROM turns WHERE couple_id=?1 ORDER BY turn_seq ASC").bind(id).all()).results ?? []) as Array<Record<string, unknown>>;
  const evs = async (kind: string) =>
    (((await env.DB.prepare("SELECT payload FROM events WHERE kind=?1 AND payload LIKE ?2 ORDER BY id ASC").bind(kind, `%"coupleId":${id}%`).all()).results ?? []) as Array<{ payload: string }>)
      .map((r) => tryParse(r.payload))
      .filter(Boolean);
  return c.json({
    couple: { id: cp.id, state: cp.state, score: cp.match_score, turns: cp.turn_count, rationale: cp.rationale },
    a: { handle: cp.a_handle, ownerId: cp.a_owner, model: cp.a_model, heart: tryParse(await open(env, cp.a_heart as string | null)) },
    b: { handle: cp.b_handle, ownerId: cp.b_owner, model: cp.b_model, heart: tryParse(await open(env, cp.b_heart as string | null)) },
    transcript: turns.map((t) => ({
      seq: t.turn_seq,
      from: t.author_kind === "system" ? "Ishtar" : t.author_id === cp.a_id ? cp.a_handle : cp.b_handle,
      line: t.body,
      status: t.status,
    })),
    reports: await evs("experiment_report"),
    reasoning: await evs("experiment_reasoning"),
  });
});
