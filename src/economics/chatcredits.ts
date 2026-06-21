/**
 * Talk-to-Ishtar credit + session accounting. Two ways to spend a message:
 *   1. a daily FREE allowance sized by the wallet's $NUMETAL perk level (holders' perk), or
 *   2. paid CREDITS bought via x402 top-up.
 * Sessions are opaque bearer tokens; only their SHA-256 hash is stored. Everything is
 * fail-safe: a perk read that fails just yields "none" (no free messages), never an error.
 */
import { eq, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { chatAccounts, chatSessions } from "../db/schema";
import type { Env } from "../env";
import { utcDay } from "../env";
import { readNumetalPerk, type PerkLevel } from "./numetal";

// Daily free messages by $NUMETAL perk tier. Holders' perk; non-holders pay per message.
const FREE_QUOTA: Record<PerkLevel, number> = { none: 0, badge: 3, priority: 10, discount: 25, founder: 200 };
const SESSION_TTL_DAYS = 30;
const PERK_CACHE_HOURS = 24;

export function creditsPerUsd(env: Env): number {
  const n = Number(env.CHAT_CREDITS_PER_USD ?? "25");
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 25;
}

export function freeQuotaFor(perk: string): number {
  return FREE_QUOTA[(perk as PerkLevel) in FREE_QUOTA ? (perk as PerkLevel) : "none"];
}

const lc = (a: string) => a.trim().toLowerCase();

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function ensureAccount(db: DB, address: string): Promise<void> {
  await db.insert(chatAccounts).values({ address: lc(address) }).onConflictDoNothing().run();
}

/** Read $NUMETAL balance (cached ~1 day) and persist the perk tier. Best-effort. */
export async function refreshPerk(db: DB, env: Env, address: string): Promise<PerkLevel> {
  const addr = lc(address);
  await ensureAccount(db, addr);
  const acct = await db.select().from(chatAccounts).where(eq(chatAccounts.address, addr)).get();
  const fresh =
    acct?.perkCheckedAt && Date.now() - new Date(acct.perkCheckedAt).getTime() < PERK_CACHE_HOURS * 3600_000;
  if (fresh) return (acct!.perkLevel as PerkLevel) ?? "none";
  const { perkLevel } = await readNumetalPerk(addr, { rpcUrl: env.BASE_RPC_URL, contract: env.NUMETAL_CA });
  await db
    .update(chatAccounts)
    .set({ perkLevel, perkCheckedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(chatAccounts.address, addr))
    .run();
  return perkLevel;
}

export interface Balance {
  perk: PerkLevel;
  credits: number;
  freeQuota: number;
  freeRemaining: number;
}

export async function getBalance(db: DB, env: Env, address: string): Promise<Balance> {
  const addr = lc(address);
  const perk = await refreshPerk(db, env, addr);
  const acct = await db.select().from(chatAccounts).where(eq(chatAccounts.address, addr)).get();
  const quota = freeQuotaFor(perk);
  const today = utcDay();
  const usedToday = acct?.freeUsedDay === today ? (acct?.freeUsedCount ?? 0) : 0;
  return { perk, credits: acct?.credits ?? 0, freeQuota: quota, freeRemaining: Math.max(0, quota - usedToday) };
}

export type ChargeResult = { ok: true; via: "free" | "paid"; balance: Balance } | { ok: false; balance: Balance };

/**
 * Charge one message: prefer the free daily allowance, then paid credits. Atomic-ish via
 * conditional UPDATEs (D1 is single-writer per row). Returns ok:false → caller responds 402.
 */
export async function chargeOne(db: DB, env: Env, address: string): Promise<ChargeResult> {
  const addr = lc(address);
  const before = await getBalance(db, env, addr);
  const today = utcDay();

  // 1) free allowance (resets daily)
  if (before.freeRemaining > 0) {
    const acct = await db.select().from(chatAccounts).where(eq(chatAccounts.address, addr)).get();
    const sameDay = acct?.freeUsedDay === today;
    await db
      .update(chatAccounts)
      .set({
        freeUsedDay: today,
        freeUsedCount: sameDay ? (acct!.freeUsedCount ?? 0) + 1 : 1,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(chatAccounts.address, addr))
      .run();
    return { ok: true, via: "free", balance: await getBalance(db, env, addr) };
  }

  // 2) paid credits — decrement only if > 0 (guards against going negative under races)
  const res = await db
    .update(chatAccounts)
    .set({ credits: sql`${chatAccounts.credits} - 1`, updatedAt: new Date().toISOString() })
    .where(sql`${chatAccounts.address} = ${addr} AND ${chatAccounts.credits} > 0`)
    .run();
  if ((res.meta?.changes ?? 0) > 0) return { ok: true, via: "paid", balance: await getBalance(db, env, addr) };

  return { ok: false, balance: before };
}

export async function addCredits(db: DB, address: string, n: number): Promise<void> {
  const addr = lc(address);
  await ensureAccount(db, addr);
  await db
    .update(chatAccounts)
    .set({ credits: sql`${chatAccounts.credits} + ${Math.max(0, Math.trunc(n))}`, updatedAt: new Date().toISOString() })
    .where(eq(chatAccounts.address, addr))
    .run();
}

/** Mint a bearer session for a (proven) address. Returns the plaintext token (shown once). */
export async function mintSession(db: DB, address: string, source: "signature" | "topup" | "admin"): Promise<{ token: string; expiresAt: string }> {
  const addr = lc(address);
  await ensureAccount(db, addr);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const token = "ish_" + [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000).toISOString();
  await db.insert(chatSessions).values({ tokenHash: await sha256Hex(token), address: addr, source, expiresAt }).run();
  return { token, expiresAt };
}

/** Resolve a bearer token → address, honoring expiry + revocation. Null if invalid. */
export async function resolveSession(db: DB, token: string): Promise<string | null> {
  if (!token || !token.startsWith("ish_")) return null;
  const row = await db.select().from(chatSessions).where(eq(chatSessions.tokenHash, await sha256Hex(token))).get();
  if (!row || row.revoked) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) return null;
  return row.address;
}
