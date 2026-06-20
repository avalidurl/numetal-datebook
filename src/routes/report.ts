/** User-side safety reporting (free, never gated beyond the staging key). */
import { Hono } from "hono";
import { z } from "zod";
import { db as makeDb } from "../db/client";
import { reports } from "../db/schema";
import type { Env } from "../env";

export const reportRoutes = new Hono<{ Bindings: Env }>();

const schema = z.object({
  targetType: z.enum(["persona", "post", "turn", "couple"]),
  targetId: z.number().int().positive(),
  reason: z.string().max(500).optional(),
});

reportRoutes.post("/report", async (c) => {
  const p = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid report" }, 400);
  await makeDb(c.env.DB)
    .insert(reports)
    .values({ targetType: p.data.targetType, targetId: p.data.targetId, reason: p.data.reason ?? "" })
    .run();
  return c.json({ ok: true });
});
