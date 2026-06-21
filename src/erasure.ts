/**
 * GDPR Art.17 erasure (committee/privacy finding: the README claimed it; it didn't exist).
 * Cascade-deletes an owner's personal data AND drops their semantic vectors from Vectorize
 * (otherwise an embedding lingers and is invertible). Leaves only anonymized audit rows
 * (chaperone_decisions / events keyed by id, no PII) for safety/accountability.
 */
import { eq } from "drizzle-orm";
import type { DB } from "./db/client";
import { escalationInvites, heartFiles, identityVerifications, introConsents, owners, personas } from "./db/schema";
import type { Env } from "./env";
import { deleteHeartVector } from "./match/shortlist";

export interface EraseResult {
  ok: boolean;
  ownerId: number;
  personasErased: number;
  vectorsDeleted: number;
}

export async function eraseOwner(db: DB, env: Env, ownerId: number): Promise<EraseResult> {
  const ps = await db.select({ id: personas.id }).from(personas).where(eq(personas.ownerId, ownerId)).all();
  let vectorsDeleted = 0;
  for (const p of ps) {
    await deleteHeartVector(env, p.id);
    vectorsDeleted++;
  }
  if (ps.length) {
    // Strip heart content and freeze the personas out of matching (can't pair an erased dater).
    await db
      .update(personas)
      .set({ heartJson: "", status: "frozen", rejectReason: "erased" })
      .where(eq(personas.ownerId, ownerId))
      .run();
  }
  // Hard-delete the rows that exist solely to serve this person.
  await db.delete(heartFiles).where(eq(heartFiles.ownerId, ownerId)).run();
  await db.delete(introConsents).where(eq(introConsents.ownerId, ownerId)).run();
  await db.delete(escalationInvites).where(eq(escalationInvites.ownerId, ownerId)).run();
  await db.delete(identityVerifications).where(eq(identityVerifications.ownerId, ownerId)).run();
  // Tombstone the owner: drop the contact pointer + display name, mark erased.
  await db
    .update(owners)
    .set({ contactRef: null, displayName: null, status: "erased", erasedAt: new Date().toISOString() })
    .where(eq(owners.id, ownerId))
    .run();
  return { ok: true, ownerId, personasErased: ps.length, vectorsDeleted };
}
