/**
 * Bounded sweep for the live-stream synthetic demo (StreamCoordinator / "watch agents date live").
 *
 * The stream spawns 2 throwaway `stream-<name>` owners + 2 personas + 1 couple per couple it starts,
 * and retired couples accumulate. `sweepRetention` never touched owners/personas, so stream OWNERS
 * leaked unbounded (a 171k-row incident, 2026-07-04). This caps the synthetic footprint on the hourly
 * cron so the demo runs forever without walking D1 toward the row/storage wall.
 *
 * Two passes, both bounded per run (LIMIT) so one cron tick can never do a giant delete:
 *   1. Retire OLD stream couples beyond the newest `keep` — delete their turns → couples → the personas
 *      of their stream owners → those owners. Keeps recent cross-model outcomes for HeartBench.
 *   2. Delete ORPHAN stream owners (a `stream-%` owner with no persona) — the leak's actual shape.
 *
 * Safety: only ever touches synthetic rows — `owners.display_name LIKE 'stream-%'` and
 * `couples.cycle_id = 'stream'`. Real owners (real/demo/trial names, wallet, heart-file, non-default
 * tier) and the one promoted experiment owner (#9013) can never match and are never deleted.
 */
import type { Env } from "../env";

const STREAM_NAME = "stream-%";
const KEEP_DEFAULT = 50; // recent stream couples kept for the live board + HeartBench outcomes
const BATCH = 4000; // max owners deleted per cron run (bounded; the backlog drains over a few ticks)

export async function sweepStreamDemo(env: Env, keepCouples?: number): Promise<{ owners: number; couples: number }> {
  const keep = Math.max(0, Number(env.STREAM_KEEP_COUPLES ?? keepCouples ?? KEEP_DEFAULT) || KEEP_DEFAULT);
  const db = env.DB;

  // ── Pass 1: retire stream couples beyond the newest `keep` (full graph) ──────────────────────
  // Old synthetic couples: cycle_id='stream', not among the newest `keep` by id. (`ended`/`dormant`/
  // `committed` and even stale `courting` all get recycled once past the window.)
  const oldCouples = (
    await db
      .prepare(
        `SELECT id, a_id, b_id FROM couples
         WHERE cycle_id='stream'
           AND id NOT IN (SELECT id FROM couples WHERE cycle_id='stream' ORDER BY id DESC LIMIT ?1)
         LIMIT 200`,
      )
      .bind(keep)
      .all()
  ).results as Array<{ id: number; a_id: number; b_id: number }>;

  let couplesDeleted = 0;
  for (const c of oldCouples) {
    // turns → couple → the two stream personas → their (stream) owners. Personas/owners are deleted
    // only when they are synthetic stream rows AND not referenced by any surviving couple.
    await db.prepare("DELETE FROM turns WHERE couple_id=?1").bind(c.id).run();
    const ownerIds = (
      await db.prepare("SELECT owner_id FROM personas WHERE id IN (?1, ?2)").bind(c.a_id, c.b_id).all()
    ).results as Array<{ owner_id: number }>;
    await db.prepare("DELETE FROM couples WHERE id=?1").bind(c.id).run();
    await db.prepare("DELETE FROM personas WHERE id IN (?1, ?2)").bind(c.a_id, c.b_id).run();
    for (const { owner_id } of ownerIds) {
      // Delete the owner only if it is a synthetic stream owner now orphaned (no surviving persona)
      // and carries no real signal (default tier, no wallet, no heart-file). #9013 is spared by tier.
      await db
        .prepare(
          `DELETE FROM owners WHERE id=?1 AND display_name LIKE '${STREAM_NAME}' AND tier='agent_represented'
             AND wallet IS NULL
             AND NOT EXISTS (SELECT 1 FROM personas p WHERE p.owner_id=owners.id)
             AND NOT EXISTS (SELECT 1 FROM heart_files hf WHERE hf.owner_id=owners.id)`,
        )
        .bind(owner_id)
        .run();
    }
    couplesDeleted++;
  }

  // ── Pass 2: sweep ORPHAN stream owners (the leak's shape), bounded per run ────────────────────
  const orphan = await db
    .prepare(
      `DELETE FROM owners WHERE id IN (
         SELECT id FROM owners
         WHERE display_name LIKE '${STREAM_NAME}' AND tier='agent_represented' AND wallet IS NULL
           AND NOT EXISTS (SELECT 1 FROM personas p WHERE p.owner_id=owners.id)
           AND NOT EXISTS (SELECT 1 FROM heart_files hf WHERE hf.owner_id=owners.id)
         LIMIT ?1)`,
    )
    .bind(BATCH)
    .run();

  return { owners: orphan.meta.changes ?? 0, couples: couplesDeleted };
}
