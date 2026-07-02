import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { db as makeDb } from "../src/db/client";
import { couples, owners, personas, tomProbes } from "../src/db/schema";
import { open, seal } from "../src/crypto/box";
import {
  getToMProbe,
  isEarnedToM,
  meanToMForProber,
  recordToMProbe,
  scoreToM,
  type InferredPrefs,
  type ToMScore,
} from "../src/match/tom";
import { eq } from "drizzle-orm";
import type { Env } from "../src/env";

const rnd = () => Math.random().toString(36).slice(2);

// A sealed heart-file with structured prefs (the ground truth the prober must infer).
const HEART = JSON.stringify({
  about: "a luthier who listens more than she talks",
  relationship_intent: "long-term",
  prefs: {
    self: { gender: "woman", age: 31, languages: ["english", "turkish"], kids: "open", substances: "none" },
    seek: { genders: ["man", "nonbinary"], ageMin: 28, ageMax: 40, languages: ["english"], dealbreakers: { substances: ["smoker"] } },
  },
});

describe("ToM scorer (pure, deterministic)", () => {
  it("rewards a fully-correct inference with a perfect score", () => {
    const inferred: InferredPrefs = {
      gender: "woman",
      age: 31,
      kids: "open",
      substances: "none",
      languages: ["english", "turkish"],
      seekGenders: ["man", "nonbinary"],
      ageMin: 28,
      ageMax: 40,
      seekLanguages: ["english"],
      excludeSubstances: ["smoker"],
    };
    const r = scoreToM(inferred, HEART);
    expect(r.score).toBe(1);
    expect(r.hits).toBe(r.compared);
    expect(r.misses).toBe(0);
    expect(r.hallucinations).toBe(0);
    expect(isEarnedToM(r)).toBe(true);
  });

  it("is order-independent on set fields (correct set in any order still a hit)", () => {
    const r = scoreToM({ seekGenders: ["nonbinary", "man"], languages: ["turkish", "english"] }, HEART);
    expect(r.hits).toBe(2);
    expect(r.misses).toBe(0);
    expect(r.score).toBe(1);
  });

  it("penalizes a WRONG inference (misses drag the score down)", () => {
    const r = scoreToM({ gender: "man", seekGenders: ["woman"], ageMin: 18, ageMax: 25 }, HEART);
    // all three claims are wrong → 0 hits over 3 comparisons
    expect(r.hits).toBe(0);
    expect(r.misses).toBe(3);
    expect(r.score).toBe(0);
    expect(isEarnedToM(r)).toBe(true); // an earned zero is still valid — it was actually scored
  });

  it("penalizes a HALLUCINATED constraint the target never stated", () => {
    // The target states NO ethnicity self/seek and NO substance exclusion beyond 'smoker'. Inventing
    // an ethnicity filter + a self-ethnicity the target never stated are hallucinations.
    const r = scoreToM({ ethnicity: "greek", seekEthnicities: ["greek"] }, HEART);
    expect(r.hallucinations).toBe(2);
    expect(r.hits).toBe(0);
    expect(r.score).toBe(0);
  });

  it("a mix of hits + a hallucination scores between 0 and 1 (earned, not stamped)", () => {
    const r = scoreToM({ gender: "woman", ethnicity: "greek" }, HEART); // 1 hit, 1 hallucination
    expect(r.hits).toBe(1);
    expect(r.hallucinations).toBe(1);
    expect(r.compared).toBe(2);
    expect(r.score).toBe(0.5);
    expect(isEarnedToM(r)).toBe(true);
  });

  it("an inference of NOTHING is not earned (compared === 0)", () => {
    const r = scoreToM({}, HEART);
    expect(r.compared).toBe(0);
    expect(r.score).toBe(0);
    expect(isEarnedToM(r)).toBe(false);
  });
});

describe("earned-score guard (reject laundered placeholder)", () => {
  it("rejects a bare 0.5 placeholder attached to a probe that inferred nothing", () => {
    const laundered: ToMScore = { score: 0.5, hits: 0, misses: 0, hallucinations: 0, compared: 0, fields: [] };
    expect(isEarnedToM(laundered)).toBe(false);
  });

  it("rejects a score that does NOT match the arithmetic its fields imply (injected constant)", () => {
    // 2 hits over 2 comparisons implies 1.0; a stamped-in 0.5 is inconsistent → rejected.
    const tampered: ToMScore = {
      score: 0.5,
      hits: 2,
      misses: 0,
      hallucinations: 0,
      compared: 2,
      fields: [
        { field: "gender", outcome: "hit", inferred: "woman", actual: "woman" },
        { field: "kids", outcome: "hit", inferred: "open", actual: "open" },
      ],
    };
    expect(isEarnedToM(tampered)).toBe(false);
  });

  it("accepts a genuinely earned 0.5 (1 hit / 2 comparisons)", () => {
    const earned = scoreToM({ gender: "woman", seekGenders: ["woman"] }, HEART); // 1 hit + 1 miss
    expect(earned.score).toBe(0.5);
    expect(isEarnedToM(earned)).toBe(true);
  });
});

describe("ToM persistence to tom_probes (HeartBench v2 contract)", () => {
  const setup = async () => {
    const db = makeDb(env.DB);
    const oa = await db.insert(owners).values({ tier: "agent_represented" }).returning({ id: owners.id }).get();
    const ob = await db.insert(owners).values({ tier: "agent_represented" }).returning({ id: owners.id }).get();
    // The target's heart is SEALED at rest (seal() no-ops without ENCRYPTION_KEY, so this also proves
    // the plaintext round-trip path). We store the sealed value and decrypt via open() before scoring.
    const sealedHeart = (await seal(env as unknown as Env, HEART)) ?? HEART;
    const pa = await db
      .insert(personas)
      .values({ ownerId: oa.id, handle: "prober" + rnd(), model: "m-a", heartJson: "{}", personaAge: "18+", status: "admitted" })
      .returning({ id: personas.id })
      .get();
    const pb = await db
      .insert(personas)
      .values({ ownerId: ob.id, handle: "target" + rnd(), model: "m-b", heartJson: sealedHeart, personaAge: "18+", status: "admitted" })
      .returning({ id: personas.id })
      .get();
    const cpl = await db.insert(couples).values({ cycleId: "tom" + rnd(), aId: pa.id, bId: pb.id, state: "courting" }).returning({ id: couples.id }).get();
    return { db, coupleId: cpl.id, prober: pa.id, target: pb.id };
  };

  it("decrypts the sealed heart, scores the inference, and persists an EARNED probe row", async () => {
    const { db, coupleId, prober, target } = await setup();
    // Read the target's sealed heart back and decrypt it exactly as the courtship code would.
    const row = await db.select({ h: personas.heartJson }).from(personas).where(eq(personas.id, target)).get();
    const truth = (await open(env as unknown as Env, row!.h)) ?? "";
    expect(truth).toContain("luthier"); // decrypt round-trip worked

    const result = scoreToM({ gender: "woman", seekGenders: ["man", "nonbinary"], seekLanguages: ["english"] }, truth);
    expect(result.score).toBe(1);
    const id = await recordToMProbe(db, { coupleId, proberPersonaId: prober, targetPersonaId: target, result });
    expect(id).toBeGreaterThan(0);

    const saved = await getToMProbe(db, coupleId, prober);
    expect(saved).toBeTruthy();
    expect(saved!.score).toBe(1);
    expect(saved!.targetPersonaId).toBe(target);
    const detail = JSON.parse(saved!.detail!);
    expect(detail.hits).toBe(3);
    expect(detail.hallucinations).toBe(0);

    const agg = await meanToMForProber(db, prober);
    expect(agg.n).toBe(1);
    expect(agg.mean).toBe(1);
  });

  it("REFUSES to persist an unearned (placeholder) score — nothing is written", async () => {
    const { db, coupleId, prober, target } = await setup();
    const placeholder: ToMScore = { score: 0.5, hits: 0, misses: 0, hallucinations: 0, compared: 0, fields: [] };
    await expect(
      recordToMProbe(db, { coupleId, proberPersonaId: prober, targetPersonaId: target, result: placeholder }),
    ).rejects.toThrow(/unearned/i);
    const rows = await db.select().from(tomProbes).where(eq(tomProbes.coupleId, coupleId)).all();
    expect(rows.length).toBe(0);
  });
});
