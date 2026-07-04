/**
 * IDOR fix (2026-07-04): the grounded compatibility report decrypts BOTH personas' private hearts, so
 * it must only run for a MEMBER of the couple. These tests exercise the authorization boundary — the
 * wallet→owner resolver and the couple-membership predicate — that gates the decrypt in
 * src/routes/premium.ts. If any of these regress, a paid caller could read a couple they are not in.
 */
import { eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { db as makeDb, type DB } from "../src/db/client";
import { couples, ownerWallets, owners, personas } from "../src/db/schema";
import { isCoupleMember, loadCoupleMembership, ownerIdForWallet } from "../src/premium/report-authz";

const WALLET_A = "0xAAaAAaaaAAAaAAaaAaAAAAaAAAaAAaAAAaAAaAA1";
const WALLET_B = "0xBBbBBbbbBBBbBBbbBbBBBBbBBBbBBbBBBbBBbBB2";
const WALLET_OUTSIDER = "0xCCcCCcccCCCcCCccCcCCCCcCCCcCCcCCCcCCcCC3";

async function newOwner(db: DB, displayName: string): Promise<number> {
  return (await db.insert(owners).values({ displayName, tier: "agent_represented" }).returning({ id: owners.id }).get()).id;
}
async function newPersona(db: DB, ownerId: number | null, handle: string): Promise<number> {
  return (
    await db
      .insert(personas)
      .values({ ownerId: ownerId ?? undefined, handle, model: "m", heartJson: "sealed", personaAge: "18+", status: "admitted" })
      .returning({ id: personas.id })
      .get()
  ).id;
}
async function bindWallet(db: DB, ownerId: number, address: string, opts?: { status?: string; chainFamily?: string }): Promise<void> {
  await db
    .insert(ownerWallets)
    .values({
      ownerId,
      provider: "external",
      chainFamily: opts?.chainFamily ?? "evm",
      network: "eip155:8453",
      address,
      status: opts?.status ?? "active",
    })
    .run();
}

describe("compatibility-report authorization (IDOR fix)", () => {
  let ownerA = 0;
  let ownerB = 0;
  let ownerOutsider = 0;
  let coupleId = 0;
  let ownerlessCoupleId = 0;

  beforeEach(async () => {
    for (const t of ["couples", "personas", "owner_wallets", "owners"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
    const db = makeDb(env.DB);
    ownerA = await newOwner(db, "A");
    ownerB = await newOwner(db, "B");
    ownerOutsider = await newOwner(db, "outsider");
    // A pays from its own registered wallet; B via the owners.wallet fallback column; outsider is bound too.
    await bindWallet(db, ownerA, WALLET_A);
    await db.update(owners).set({ wallet: WALLET_B.toLowerCase() }).where(eq(owners.id, ownerB)).run();
    await bindWallet(db, ownerOutsider, WALLET_OUTSIDER);
    const pa = await newPersona(db, ownerA, "@a");
    const pb = await newPersona(db, ownerB, "@b");
    coupleId = (await db.insert(couples).values({ cycleId: "c1", aId: pa, bId: pb }).returning({ id: couples.id }).get()).id;
    // A couple whose personas have NO owner (redteam/experiment) — nobody may ground it.
    const pn1 = await newPersona(db, null, "@n1");
    const pn2 = await newPersona(db, null, "@n2");
    ownerlessCoupleId = (await db.insert(couples).values({ cycleId: "c2", aId: pn1, bId: pn2 }).returning({ id: couples.id }).get()).id;
  });

  describe("ownerIdForWallet", () => {
    it("resolves via the owner_wallets ledger, case-insensitively", async () => {
      expect(await ownerIdForWallet(env, WALLET_A)).toBe(ownerA);
      expect(await ownerIdForWallet(env, WALLET_A.toLowerCase())).toBe(ownerA);
      expect(await ownerIdForWallet(env, WALLET_A.toUpperCase())).toBe(ownerA);
    });
    it("falls back to the owners.wallet column", async () => {
      expect(await ownerIdForWallet(env, WALLET_B)).toBe(ownerB);
    });
    it("returns null for an unknown, empty, or null wallet — fail closed", async () => {
      expect(await ownerIdForWallet(env, "0xdeadbeef00000000000000000000000000000000")).toBeNull();
      expect(await ownerIdForWallet(env, "")).toBeNull();
      expect(await ownerIdForWallet(env, "   ")).toBeNull();
      expect(await ownerIdForWallet(env, null)).toBeNull();
      expect(await ownerIdForWallet(env, undefined)).toBeNull();
    });
    it("ignores inactive and non-EVM wallet rows", async () => {
      const db = makeDb(env.DB);
      const o = await newOwner(db, "revoked");
      await bindWallet(db, o, "0x1111111111111111111111111111111111111111", { status: "revoked" });
      await bindWallet(db, o, "0x2222222222222222222222222222222222222222", { chainFamily: "solana" });
      expect(await ownerIdForWallet(env, "0x1111111111111111111111111111111111111111")).toBeNull();
      expect(await ownerIdForWallet(env, "0x2222222222222222222222222222222222222222")).toBeNull();
    });
  });

  describe("loadCoupleMembership + isCoupleMember", () => {
    it("admits an owner of persona A", async () => {
      const m = await loadCoupleMembership(env, coupleId);
      expect(isCoupleMember(m, ownerA)).toBe(true);
    });
    it("admits an owner of persona B", async () => {
      const m = await loadCoupleMembership(env, coupleId);
      expect(isCoupleMember(m, ownerB)).toBe(true);
    });
    it("REFUSES an outsider who owns neither persona", async () => {
      const m = await loadCoupleMembership(env, coupleId);
      expect(isCoupleMember(m, ownerOutsider)).toBe(false);
    });
    it("REFUSES a null caller (unresolvable payer)", async () => {
      const m = await loadCoupleMembership(env, coupleId);
      expect(isCoupleMember(m, null)).toBe(false);
    });
    it("REFUSES everyone on an ownerless couple (null persona owners never match)", async () => {
      const m = await loadCoupleMembership(env, ownerlessCoupleId);
      expect(m.ownerA).toBeNull();
      expect(m.ownerB).toBeNull();
      expect(isCoupleMember(m, ownerA)).toBe(false);
      expect(isCoupleMember(m, null)).toBe(false);
    });
    it("reports a missing couple as null and admits no one", async () => {
      const m = await loadCoupleMembership(env, 9_999_999);
      expect(m.couple).toBeNull();
      expect(isCoupleMember(m, ownerA)).toBe(false);
    });
  });

  describe("end-to-end wallet → owner → membership (the exact route path)", () => {
    it("a couple member's wallet authorizes; an outsider's wallet does not", async () => {
      const m = await loadCoupleMembership(env, coupleId);
      // member pays from WALLET_A → resolves to ownerA → member of the couple
      expect(isCoupleMember(m, await ownerIdForWallet(env, WALLET_A))).toBe(true);
      // outsider pays from WALLET_OUTSIDER → resolves to ownerOutsider → NOT a member
      expect(isCoupleMember(m, await ownerIdForWallet(env, WALLET_OUTSIDER))).toBe(false);
      // attacker pays from a wallet bound to no owner → null → refused
      expect(isCoupleMember(m, await ownerIdForWallet(env, "0xf00df00df00df00df00df00df00df00df00df00d"))).toBe(false);
    });
  });
});
