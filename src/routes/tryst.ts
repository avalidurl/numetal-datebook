/**
 * Tryst rooms (GOK-134) — ephemeral "burner" rooms where a matched couple (agents, and their humans
 * if both consent) exchange details, then the room ceases to exist. TTL 24h → purged on the cron;
 * on purge the content is DELETED and a signed DELETION CERTIFICATE is retained (room hash, lifetimes,
 * moderation-flag counts only) — proof-of-innocence v0: we prove what we screened and that we deleted,
 * keeping nothing. Private ≠ unmoderated: every append is chaperoned before it's stored.
 */
import { Hono } from "hono";
import { z } from "zod";
import { db as makeDb } from "../db/client";
import type { Env } from "../env";
import { chaperone } from "../chaperone";
import { hmacHex } from "../crypto/box";

export const trystRoutes = new Hono<{ Bindings: Env }>();

const TTL_MS = 24 * 60 * 60 * 1000;
const openSchema = z.object({ coupleId: z.number().int().positive() });
const appendSchema = z.object({ authorId: z.number().int().positive(), body: z.string().min(1).max(2000) });

// Open (or reuse) the single live room for a couple. TTL 24h.
trystRoutes.post("/tryst/open", async (c) => {
  const p = openSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "coupleId required" }, 400);
  const couple = await c.env.DB.prepare("SELECT id FROM couples WHERE id=?1").bind(p.data.coupleId).first<{ id: number }>();
  if (!couple) return c.json({ error: "no such couple" }, 404);
  const open = await c.env.DB.prepare("SELECT id, expires_at FROM tryst_rooms WHERE couple_id=?1 AND status='open' ORDER BY id DESC LIMIT 1").bind(p.data.coupleId).first<{ id: number; expires_at: string }>();
  if (open) return c.json({ ok: true, roomId: open.id, expiresAt: open.expires_at, reused: true });
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  const ins = await c.env.DB.prepare("INSERT INTO tryst_rooms (couple_id, expires_at) VALUES (?1, ?2) RETURNING id").bind(p.data.coupleId, expiresAt).first<{ id: number }>();
  return c.json({ ok: true, roomId: ins?.id, expiresAt });
});

// Append a chaperone-gated message. Unsafe content is HELD (counted as a mod flag), never stored.
trystRoutes.post("/tryst/:roomId/append", async (c) => {
  const roomId = Number(c.req.param("roomId"));
  if (!Number.isInteger(roomId) || roomId <= 0) return c.json({ error: "bad roomId" }, 400);
  const p = appendSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "authorId + body required" }, 400);
  const room = await c.env.DB.prepare("SELECT status, expires_at FROM tryst_rooms WHERE id=?1").bind(roomId).first<{ status: string; expires_at: string }>();
  if (!room) return c.json({ error: "no such room" }, 404);
  if (room.status !== "open" || room.expires_at < new Date().toISOString()) return c.json({ error: "room closed" }, 410);
  const v = await chaperone(makeDb(c.env.DB), c.env, { stage: "pre_turn", targetType: "turn", targetId: roomId, text: p.data.body, callerRef: "tryst" });
  if (v.verdict !== "allow" && v.verdict !== "sanitize") {
    await c.env.DB.prepare("UPDATE tryst_rooms SET mod_flags = mod_flags + 1 WHERE id=?1").bind(roomId).run();
    return c.json({ ok: false, held: true, reason: v.reason });
  }
  await c.env.DB.prepare("INSERT INTO tryst_messages (room_id, author_id, body) VALUES (?1,?2,?3)").bind(roomId, p.data.authorId, v.text ?? p.data.body).run();
  await c.env.DB.prepare("UPDATE tryst_rooms SET msg_count = msg_count + 1 WHERE id=?1").bind(roomId).run();
  return c.json({ ok: true, status: "published" });
});

// Read a room. Open → messages; purged → the deletion certificate, no content.
trystRoutes.get("/tryst/:roomId", async (c) => {
  const roomId = Number(c.req.param("roomId"));
  if (!Number.isInteger(roomId) || roomId <= 0) return c.json({ error: "bad roomId" }, 400);
  const room = await c.env.DB.prepare("SELECT couple_id, status, msg_count, mod_flags, created_at, expires_at, purged_at, cert FROM tryst_rooms WHERE id=?1").bind(roomId).first<Record<string, unknown>>();
  if (!room) return c.json({ error: "no such room" }, 404);
  if (room.status === "purged")
    return c.json({ ok: true, status: "purged", certificate: room.cert, purgedAt: room.purged_at, msgCount: room.msg_count, modFlags: room.mod_flags, note: "Room burned. Content deleted; this signed certificate proves what was screened and that nothing was kept." });
  const msgs = (await c.env.DB.prepare("SELECT author_id, body, created_at FROM tryst_messages WHERE room_id=?1 ORDER BY id ASC").bind(roomId).all()).results;
  return c.json({ ok: true, status: "open", roomId, coupleId: room.couple_id, expiresAt: room.expires_at, messages: msgs });
});

/** Purge expired rooms (hourly cron): delete content, retain a signed deletion certificate. */
export async function purgeExpiredTrysts(env: Env): Promise<{ purged: number }> {
  const now = new Date().toISOString();
  const expired = (
    await env.DB.prepare("SELECT id, couple_id, msg_count, mod_flags, created_at FROM tryst_rooms WHERE status='open' AND expires_at < ?1 LIMIT 200").bind(now).all()
  ).results as Array<{ id: number; couple_id: number; msg_count: number; mod_flags: number; created_at: string }>;
  let purged = 0;
  for (const r of expired) {
    const cert = await hmacHex(env, JSON.stringify({ roomId: r.id, coupleId: r.couple_id, createdAt: r.created_at, purgedAt: now, msgCount: r.msg_count, modFlags: r.mod_flags }));
    await env.DB.prepare("DELETE FROM tryst_messages WHERE room_id=?1").bind(r.id).run();
    await env.DB.prepare("UPDATE tryst_rooms SET status='purged', purged_at=?2, cert=?3 WHERE id=?1").bind(r.id, now, `cert:v1:${cert}`).run();
    purged++;
  }
  return { purged };
}
