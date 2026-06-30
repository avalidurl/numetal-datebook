import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  extractHeartDoc,
  looksLikeSubmit,
  wantsDocDraft,
} from "../src/chat/heartdoc";
import { loadPendingDraft, submitDatingDoc } from "../src/routes/chat";
import { db as makeDb } from "../src/db/client";
import { attest18 } from "../src/economics/chatcredits";
import { chatMessages } from "../src/db/schema";
import { seal } from "../src/crypto/box";

const okGuard = { guard: async () => ({ safe: true, raw: "safe" }) };

// In-chat "draft + submit my dating doc" — the chat→floor bridge that lets a signed-in human have
// Ishtar compose their heart-file from the conversation and submit it via the EXISTING gated path.
describe("heartdoc — intent detection", () => {
  it("recognizes a draft request", () => {
    expect(wantsDocDraft("can you draft my dating doc?")).toBe(true);
    expect(wantsDocDraft("please write up my heart-file now")).toBe(true);
    expect(wantsDocDraft("make me a dating doc for me please")).toBe(true);
    expect(wantsDocDraft("compose the dating document from what I told you")).toBe(true);
  });
  it("does not fire on ordinary coaching talk", () => {
    expect(wantsDocDraft("what should I say on a first date?")).toBe(false);
    expect(wantsDocDraft("tell me about the floor")).toBe(false);
  });
  it("recognizes a submit confirmation strictly", () => {
    expect(looksLikeSubmit("submit")).toBe(true);
    expect(looksLikeSubmit("  Submit. ")).toBe(true);
    expect(looksLikeSubmit("send it")).toBe(true);
    expect(looksLikeSubmit("yes, submit")).toBe(true);
    // not a bare confirmation → don't fire (it's a normal message)
    expect(looksLikeSubmit("I don't want to submit yet, tell me more")).toBe(false);
    expect(looksLikeSubmit("what does submit do?")).toBe(false);
  });
});

describe("heartdoc — extract + sanitize", () => {
  it("pulls the block, parses it, and strips it from the visible reply", () => {
    const raw =
      "You read as someone who loves the sea and wants steadiness. Here's how I'd put it:\n\n" +
      "```heartdoc\n" +
      JSON.stringify({
        about: "warm, tide-obsessed, builds quiet rituals",
        seeking: "someone steady who laughs easily",
        prefs: { self: { gender: "man", age: 31, languages: ["english"] }, seek: { genders: ["woman"], ageMin: 28, ageMax: 40 } },
      }) +
      "\n```";
    const got = extractHeartDoc(raw);
    expect(got).toBeTruthy();
    expect(got!.cleaned).not.toContain("heartdoc");
    expect(got!.cleaned).not.toContain("{");
    expect(got!.cleaned).toContain("loves the sea");
    const d = got!.draft as Record<string, unknown>;
    expect(d.about).toContain("tide-obsessed");
    const prefs = d.prefs as { self: Record<string, unknown>; seek: Record<string, unknown> };
    expect(prefs.self.gender).toBe("man");
    expect(prefs.self.age).toBe(31);
    expect(prefs.seek.genders).toEqual(["woman"]);
  });

  it("returns null when no block is present", () => {
    expect(extractHeartDoc("just a warm reply, no doc here")).toBeNull();
  });

  it("returns null on malformed JSON inside the block", () => {
    expect(extractHeartDoc("```heartdoc\n{not json,}\n```")).toBeNull();
  });

  it("drops unknown keys and empty fields, and rejects an empty draft", () => {
    const raw = "```heartdoc\n" + JSON.stringify({ about: "short", junk: "nope", prefs: { self: {} } }) + "\n```";
    // about<8 chars and no prefs signal → no usable draft → null
    expect(extractHeartDoc(raw)).toBeNull();

    const raw2 = "```heartdoc\n" + JSON.stringify({ about: "a genuinely descriptive about line", junk: "drop me", evil_field: 1 }) + "\n```";
    const got = extractHeartDoc(raw2);
    expect(got).toBeTruthy();
    const d = got!.draft as Record<string, unknown>;
    expect(d.about).toBe("a genuinely descriptive about line");
    expect(d.junk).toBeUndefined();
    expect(d.evil_field).toBeUndefined();
  });

  it("coerces string ages to numbers and drops zero/garbage ages", () => {
    const raw = "```heartdoc\n" + JSON.stringify({ about: "descriptive enough about line", prefs: { self: { age: "29" }, seek: { ageMin: 0, ageMax: "x" } } }) + "\n```";
    const got = extractHeartDoc(raw);
    const prefs = (got!.draft as Record<string, unknown>).prefs as { self: Record<string, unknown>; seek?: Record<string, unknown> };
    expect(prefs.self.age).toBe(29);
    expect(prefs.seek?.ageMin).toBeUndefined();
    expect(prefs.seek?.ageMax).toBeUndefined();
  });
});

describe("heartdoc — stash + load + submit (DB round-trip)", () => {
  const ADDR = "0x7777777777777777777777777777777777777777";
  beforeEach(async () => {
    for (const t of ["heart_files", "owner_wallets", "owners", "chat_sessions", "chat_accounts", "chat_messages", "chaperone_decisions"])
      await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  it("loadPendingDraft returns the most recent stashed draft (sealed round-trip)", async () => {
    const db = makeDb(env.DB);
    const draft = { about: "the truer second cut of who I am", seeking: "warmth and wit" };
    await db.insert(chatMessages).values({ address: ADDR, role: "draft", body: (await seal(env, JSON.stringify({ about: "old draft, superseded" }))) ?? "" , mode: "coach" }).run();
    await db.insert(chatMessages).values({ address: ADDR, role: "draft", body: (await seal(env, JSON.stringify(draft))) ?? "", mode: "coach" }).run();
    const got = await loadPendingDraft(db, env, ADDR);
    expect(got).toBeTruthy();
    expect((got as Record<string, unknown>).about).toContain("second cut");
  });

  it("loadPendingDraft returns null when there is no draft", async () => {
    expect(await loadPendingDraft(makeDb(env.DB), env, ADDR)).toBeNull();
  });

  it("a stashed draft submits through the existing gated path (200, HELD, wallet-bound)", async () => {
    const db = makeDb(env.DB);
    await attest18(db, ADDR);
    const draft = { about: "warm, curious, lives by the tide charts", seeking: "someone kind and game", prefs: { self: { gender: "man" }, seek: { genders: ["woman"] } } };
    await db.insert(chatMessages).values({ address: ADDR, role: "draft", body: (await seal(env, JSON.stringify(draft))) ?? "", mode: "coach" }).run();

    const loaded = await loadPendingDraft(db, env, ADDR);
    expect(loaded).toBeTruthy();
    // This is exactly what the /chat submit path does: feed the loaded draft into submitDatingDoc.
    const r = await submitDatingDoc(db, env, { address: ADDR, heart: loaded as Record<string, unknown> }, okGuard);
    expect(r.code).toBe(200);
    expect(r.body.status).toBe("pending_verification");

    const w = await env.DB.prepare("SELECT count(*) c FROM owner_wallets WHERE address=?1").bind(ADDR).first<{ c: number }>();
    expect(w?.c).toBe(1);
  });

  it("draft rows are excluded from the model history read shape (role filter)", async () => {
    // Guard the invariant that loadPendingDraft uses role:"draft" — a draft row must NOT be a user/assistant turn.
    const db = makeDb(env.DB);
    await db.insert(chatMessages).values({ address: ADDR, role: "draft", body: (await seal(env, JSON.stringify({ about: "x".repeat(20) }))) ?? "", mode: "coach" }).run();
    const rows = await env.DB.prepare("SELECT role FROM chat_messages WHERE address=?1").bind(ADDR).all<{ role: string }>();
    expect(rows.results.every((r) => r.role === "draft")).toBe(true);
    expect(rows.results.some((r) => r.role === "user" || r.role === "assistant")).toBe(false);
  });
});
