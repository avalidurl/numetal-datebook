/**
 * GDPR Art.17 erasure (committee/privacy finding: the README claimed it; it didn't exist).
 * Cascade-deletes an owner's personal data AND drops their semantic vectors from Vectorize
 * (otherwise an embedding lingers and is invertible). Leaves only anonymized audit rows
 * (chaperone_decisions / events keyed by id, no PII) for safety/accountability.
 */
import { eq, inArray } from "drizzle-orm";
import type { DB } from "./db/client";
import {
  agentEndpoints,
  chatMessages,
  chatTopups,
  escalationInvites,
  heartFiles,
  identityVerifications,
  introConsents,
  numetalPerks,
  owners,
  ownerWallets,
  paymentReceipts,
  personas,
  premiumOrders,
} from "./db/schema";
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
  // Red-team M1: erasure must cover EVERY owner-linked table, or relay tokens, wallet/perk rows,
  // and reconstructable spend/chat history survive a deletion request.
  // Resolve wallet addresses BEFORE dropping the wallet rows (chat is keyed by address, not owner).
  const wallets = await db.select({ address: ownerWallets.address }).from(ownerWallets).where(eq(ownerWallets.ownerId, ownerId)).all();
  const addrs = wallets.map((w) => w.address).filter(Boolean) as string[];
  if (addrs.length) {
    await db.delete(chatMessages).where(inArray(chatMessages.address, addrs)).run();
    await db.delete(chatTopups).where(inArray(chatTopups.payer, addrs)).run();
  }
  // Financial records tied to this owner (delete receipts first — they FK premium_orders.orderId).
  const orders = await db.select({ orderId: premiumOrders.orderId }).from(premiumOrders).where(eq(premiumOrders.ownerId, ownerId)).all();
  const orderIds = orders.map((o) => o.orderId);
  if (orderIds.length) await db.delete(paymentReceipts).where(inArray(paymentReceipts.orderId, orderIds)).run();
  await db.delete(premiumOrders).where(eq(premiumOrders.ownerId, ownerId)).run();
  await db.delete(agentEndpoints).where(eq(agentEndpoints.ownerId, ownerId)).run();
  await db.delete(numetalPerks).where(eq(numetalPerks.ownerId, ownerId)).run();
  await db.delete(ownerWallets).where(eq(ownerWallets.ownerId, ownerId)).run();
  await env.DB.prepare("DELETE FROM relay_sessions WHERE owner_id=?1").bind(ownerId).run(); // raw table (migration 0008)
  // Tombstone the owner: drop the contact pointer + display name, mark erased.
  await db
    .update(owners)
    .set({ contactRef: null, displayName: null, status: "erased", erasedAt: new Date().toISOString() })
    .where(eq(owners.id, ownerId))
    .run();
  return { ok: true, ownerId, personasErased: ps.length, vectorsDeleted };
}
