import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { recordEpisode, recordFeedback } from "../src/coach/memory";
import { open, seal } from "../src/crypto/box";
import { db as makeDb } from "../src/db/client";
import type { Env } from "../src/env";

// Human chat PII must not sit in D1 in the clear. These tests prove the three cleartext stores
// (chat_messages.body, episodes.content, coach_feedback.body) are sealed at rest with AES-GCM, and
// that the read paths recover plaintext — while staying backward-compatible when no key is set.
// recordEpisode/recordFeedback take `env` only to read ENCRYPTION_KEY (they use the passed `db` for
// storage), so a minimal env object is sufficient and avoids spreading the cloudflare:test proxy.
const keyB64 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const keyed = { ENCRYPTION_KEY: keyB64 } as unknown as Env;
const dark = {} as unknown as Env;

const ADDR = "0x5555555555555555555555555555555555555555";
const PII = "my SSN is 123-45-6789 and I live at 42 Elm Street, Springfield";

/** Read the RAW stored value straight from D1 — bypassing any decrypt — to prove at-rest ciphertext. */
async function rawCol(table: string, col: string, subjectCol: string, subject: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT ${col} AS v FROM ${table} WHERE ${subjectCol}=?1 LIMIT 1`)
    .bind(subject)
    .first<{ v: string }>();
  return row?.v ?? null;
}

describe("chat PII sealed at rest (D1 column encryption)", () => {
  beforeEach(async () => {
    for (const t of ["episodes", "coach_feedback", "chat_messages", "chat_accounts"])
      await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  it("episodes.content is ciphertext in D1 and decrypts back via open()", async () => {
    await recordEpisode(makeDb(env.DB), keyed, { subject: ADDR, kind: "advice", content: PII });
    const raw = await rawCol("episodes", "content", "subject", ADDR.toLowerCase());
    expect(raw).toMatch(/^enc:v1:/);
    expect(raw).not.toContain("123-45-6789");
    expect(raw).not.toContain("Elm Street");
    expect(await open(keyed, raw)).toBe(PII);
  });

  it("recordFeedback seals BOTH coach_feedback.body and the minted episode", async () => {
    const debrief = `We met at 742 Evergreen Terrace; ${PII}`;
    await recordFeedback(makeDb(env.DB), keyed, { subject: ADDR, kind: "debrief", body: debrief });

    const fb = await rawCol("coach_feedback", "body", "subject", ADDR.toLowerCase());
    expect(fb).toMatch(/^enc:v1:/);
    expect(fb).not.toContain("Evergreen Terrace");
    expect(await open(keyed, fb)).toBe(debrief.slice(0, 4000));

    const ep = await rawCol("episodes", "content", "subject", ADDR.toLowerCase());
    expect(ep).toMatch(/^enc:v1:/);
    expect(ep).not.toContain("Evergreen Terrace");
  });

  it("chat_messages.body round-trips: sealed on write (chat.ts), recovered on read (ishtar.ts)", async () => {
    const sealed = (await seal(keyed, PII)) ?? PII; // mirrors the insert in src/routes/chat.ts
    await env.DB.prepare("INSERT INTO chat_messages (address, role, body, mode) VALUES (?1,'user',?2,'chat')")
      .bind(ADDR, sealed)
      .run();
    const raw = await rawCol("chat_messages", "body", "address", ADDR);
    expect(raw).toMatch(/^enc:v1:/);
    expect(raw).not.toContain("123-45-6789");
    expect(await open(keyed, raw)).toBe(PII); // mirrors the history decrypt in src/chat/ishtar.ts
  });

  it("dark mode (no ENCRYPTION_KEY): stores plaintext + reads legacy rows unchanged — backward compatible", async () => {
    await recordEpisode(makeDb(env.DB), dark, { subject: ADDR, kind: "advice", content: "plain text episode" });
    const raw = await rawCol("episodes", "content", "subject", ADDR.toLowerCase());
    expect(raw).toBe("plain text episode"); // no enc:v1: prefix when the key is unset
    expect(await open(dark, raw)).toBe("plain text episode"); // unprefixed legacy row → returned as-is
  });
});
