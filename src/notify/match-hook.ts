/**
 * Match → notify trigger glue.
 *
 * Called from the match coordinator the instant a NEW couple row is created. It resolves the couple's
 * two owners, keeps only the ones who are ENROLLED HUMANS (arrived via a featured post), and fires a
 * 'come look' match alert (notifyOwner) for each. Best-effort + fail-soft: it NEVER throws, so a notify
 * problem can never abort or stall a match beat.
 *
 * ENROLLED-HUMAN GATE (shared contract with the sibling enrol branch):
 *   featured_posts.owner_id links a featured post → its enrolled owner. An owner is an enrolled human if
 *   a featured_posts row exists with owner_id = <ownerId> AND author_kind = 'human'.
 *
 * COLUMN DEPENDENCY: featured_posts.owner_id is added by the enrol branch, which is NOT yet merged into
 * the base this branch forks from. So we FEATURE-DETECT the column at runtime: until it exists the gate
 * matches no one and the hook is a silent no-op (matching is unaffected). The moment the enrol branch
 * lands the column, enrolled-human matches start emailing with zero further change here.
 */
import type { Env } from "../env";
import { matchesUrl, notifyOwner } from "./dispatch";

/**
 * Does featured_posts.owner_id exist yet? Probed fresh each time (a cheap PRAGMA, run only once per
 * couple creation — couples form on the hourly beat, so the cost is negligible). NOT cached: the column
 * appears the moment the enrol branch's migration lands, and we want the gate to start working then with
 * no redeploy; caching a negative would freeze it off for the isolate's lifetime.
 */
async function featuredHasOwnerId(d1: D1Database): Promise<boolean> {
  try {
    const cols = (await d1.prepare("PRAGMA table_info(featured_posts)").all()).results as Array<{ name: string }>;
    return cols.some((c) => c.name === "owner_id");
  } catch {
    return false;
  }
}

/** The owner ids behind a couple's two personas (deduped, non-null). */
async function coupleOwnerIds(d1: D1Database, coupleId: number): Promise<number[]> {
  const couple = (await d1.prepare("SELECT a_id, b_id FROM couples WHERE id = ?1").bind(coupleId).first()) as
    | { a_id: number; b_id: number }
    | null;
  if (!couple) return [];
  const rows = (
    await d1.prepare("SELECT owner_id FROM personas WHERE id IN (?1, ?2)").bind(couple.a_id, couple.b_id).all()
  ).results as Array<{ owner_id: number | null }>;
  const ids = new Set<number>();
  for (const r of rows) if (r.owner_id != null) ids.add(r.owner_id);
  return [...ids];
}

/**
 * Of these owner ids, which are enrolled humans (a featured post with owner_id = them, author_kind
 * 'human')? Returns [] when the owner_id column doesn't exist yet (enrol branch not merged).
 */
async function enrolledHumanOwners(d1: D1Database, ownerIds: number[]): Promise<number[]> {
  if (!ownerIds.length) return [];
  if (!(await featuredHasOwnerId(d1))) return []; // dependency: column ships with the enrol branch
  const out: number[] = [];
  for (const id of ownerIds) {
    try {
      const row = await d1
        .prepare("SELECT 1 AS hit FROM featured_posts WHERE owner_id = ?1 AND author_kind = 'human' LIMIT 1")
        .bind(id)
        .first();
      if (row) out.push(id);
    } catch {
      /* a malformed featured_posts read for one owner must not drop the others */
    }
  }
  return out;
}

/**
 * Fire match alerts for any enrolled human in a freshly-formed couple. Idempotent (notifyOwner keys on
 * the couple id), best-effort, never throws. Call it right after the couple row is inserted.
 */
export async function notifyMatchForCouple(env: Env, coupleId: number): Promise<void> {
  try {
    const d1 = env.DB;
    const ownerIds = await coupleOwnerIds(d1, coupleId);
    const humans = await enrolledHumanOwners(d1, ownerIds);
    for (const ownerId of humans) {
      const url = await matchesUrl(env, ownerId);
      await notifyOwner(d1, env, ownerId, "match", { coupleId, matchesUrl: url });
    }
  } catch {
    /* fail-soft: matching must never break because a notify failed */
  }
}
