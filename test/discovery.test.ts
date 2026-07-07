import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { buildOpenApi } from "../src/discovery/openapi";
import type { Env } from "../src/env";

const PAY = "0x36de990133d36d7e3df9a820aa3ede5a2320de71";
const post = async (path: string, e: Env, body?: unknown) => {
  const ctx = createExecutionContext();
  const r = await worker.fetch(
    new Request(`https://d${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cf: { country: "US" },
    }),
    e,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return r;
};

describe("discovery — bare unpaid probe reaches 402 BEFORE body validation, no side effects", () => {
  const e = () => ({ ...env, PAY_TO: PAY }) as Env;

  it("POST /api/chat/topup with no payment + no body → 402 (not 400)", async () => {
    const r = await post("/api/chat/topup", e());
    expect(r.status).toBe(402);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    const body = (await r.json()) as { extensions?: { bazaar?: { schema?: { properties?: Record<string, unknown> } } } };
    expect(body.extensions?.bazaar?.schema?.properties?.input).toBeTruthy();
    expect(body.extensions?.bazaar?.schema?.properties?.output).toBeTruthy();
  });

  it("POST /api/intake/heart-file with no payment + no body → 402 with MPP when enabled", async () => {
    const r = await post("/api/intake/heart-file", { ...env, PAY_TO: PAY, MPP_ENABLED: "1", MPP_SECRET_KEY: "x" } as Env);
    expect(r.status).toBe(402);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(r.headers.get("WWW-Authenticate")).toMatch(/^Payment /);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("POST /api/featured/post with no payment + no body → 402, and NO slot reserved", async () => {
    await env.DB.prepare("DELETE FROM featured_posts").run();
    const r = await post("/api/featured/post", e());
    expect(r.status).toBe(402);
    expect(r.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM featured_posts").first<{ n: number }>();
    expect(n?.n).toBe(0); // the probe must never claim/reserve a slot
  });

  it("both still 503 when PAY_TO is unset (payments not configured)", async () => {
    const r = await post("/api/chat/topup", { ...env, PAY_TO: undefined } as Env);
    expect(r.status).toBe(503);
  });
});

describe("discovery — /openapi.json declares the paid surfaces", () => {
  it("declares ask (x402+mpp), heart-file, topup, window — all with x-payment-info + schemas", () => {
    const doc = buildOpenApi({ ...env, PAY_TO: PAY, MPP_ENABLED: "1", MPP_SECRET_KEY: "x", MPP_PULL_ENABLED: "1" } as Env) as {
      paths: Record<string, { post?: { "x-payment-info"?: { protocols: unknown[]; price: { amount: string } }; requestBody?: unknown } }>;
    };
    const paid = ["/api/chat/ask", "/api/intake/heart-file", "/api/chat/topup", "/api/featured/post"];
    for (const p of paid) {
      const op = doc.paths[p]?.post;
      expect(op?.["x-payment-info"], `${p} x-payment-info`).toBeTruthy();
      expect(op?.requestBody, `${p} requestBody`).toBeTruthy();
    }
    // ask + topup + heart-file + window carry both rails (ask/heart/window push, topup pull)
    const proto = (p: string) => (doc.paths[p]!.post!["x-payment-info"]!.protocols as Array<Record<string, unknown>>).map((x) => Object.keys(x)[0]);
    expect(proto("/api/chat/ask")).toEqual(["x402", "mpp"]);
    expect(proto("/api/chat/topup")).toEqual(["x402", "mpp"]);
    expect(proto("/api/intake/heart-file")).toEqual(["x402", "mpp"]);
    expect(proto("/api/featured/post")).toEqual(["x402", "mpp"]);
    expect(doc.paths["/api/chat/topup"]!.post!["x-payment-info"]!.price.amount).toBe("2.000000");
    // per-SKU supportedModes: ask push, topup pull
    const mppOf = (p: string) => (doc.paths[p]!.post!["x-payment-info"]!.protocols as Array<Record<string, { supportedModes?: string[] }>>).find((x) => x.mpp)?.mpp;
    expect(mppOf("/api/chat/ask")?.supportedModes).toEqual(["push"]);
    expect(mppOf("/api/chat/topup")?.supportedModes).toEqual(["pull"]);
    expect(mppOf("/api/intake/heart-file")?.supportedModes).toEqual(["push"]);
    expect(mppOf("/api/featured/post")?.supportedModes).toEqual(["push"]);
  });

  it("declares components.securitySchemes and references them per paid op (AgentCash sell-to-agents)", () => {
    const doc = buildOpenApi({ ...env, PAY_TO: PAY, MPP_ENABLED: "1", MPP_SECRET_KEY: "x", MPP_PULL_ENABLED: "1" } as Env) as {
      info: { contact?: { email?: string } };
      components?: { securitySchemes?: Record<string, { type?: string; scheme?: string; name?: string }> };
      paths: Record<string, { post?: { security?: Array<Record<string, string[]>> } }>;
    };
    // schemes exist and are accurately typed
    const schemes = doc.components?.securitySchemes ?? {};
    expect(schemes.x402).toMatchObject({ type: "apiKey", in: "header", name: "payment-signature" });
    expect(schemes.mpp).toMatchObject({ type: "http", scheme: "Payment" });
    // documented ownership contact
    expect(doc.info.contact?.email).toBe("contact@gokhan.vc");
    // each paid op references the scheme keys it accepts; ask carries both rails
    const secKeys = (p: string) => (doc.paths[p]!.post!.security ?? []).flatMap((s) => Object.keys(s));
    expect(secKeys("/api/chat/ask")).toEqual(["x402", "mpp"]);
    expect(secKeys("/api/intake/heart-file")).toEqual(["x402", "mpp"]);
    expect(secKeys("/api/featured/post")).toEqual(["x402", "mpp"]);
    // every referenced scheme is defined in components
    for (const p of ["/api/chat/ask", "/api/intake/heart-file", "/api/chat/topup", "/api/featured/post"]) {
      for (const k of secKeys(p)) expect(schemes[k], `${p} references undefined scheme ${k}`).toBeTruthy();
    }
  });

  it("emits x-discovery.ownershipProofs only when AGENTCASH_OWNERSHIP_PROOF is set", () => {
    const without = buildOpenApi({ ...env, PAY_TO: PAY } as Env) as Record<string, unknown>;
    expect(without["x-discovery"]).toBeUndefined();
    const withProof = buildOpenApi({ ...env, PAY_TO: PAY, AGENTCASH_OWNERSHIP_PROOF: "proof-a, proof-b" } as Env) as {
      "x-discovery"?: { ownershipProofs?: string[] };
    };
    expect(withProof["x-discovery"]?.ownershipProofs).toEqual(["proof-a", "proof-b"]);
  });

  it("declares free public reads with explicit security: [] (registry registers them, not skipped)", () => {
    const doc = buildOpenApi({ ...env, PAY_TO: PAY } as Env) as {
      paths: Record<string, { get?: { security?: unknown[]; "x-payment-info"?: unknown } }>;
    };
    const freePublicGets = [
      "/api/floor",
      "/api/public/stats",
      "/api/heartbench",
      "/api/heartbench/scenarios",
      "/api/heartbench/scenarios/{id}",
      "/api/heartbench/view",
    ];
    for (const p of freePublicGets) {
      const op = doc.paths[p]?.get;
      expect(op, `${p} GET`).toBeTruthy();
      expect(op?.security, `${p} security`).toEqual([]);
      expect(op?.["x-payment-info"], `${p} not paid`).toBeUndefined();
    }
  });

  it("discloses what $2 buys (block size) + the off-topic charge WITHOUT paying (session-audit gap 2026-07-04)", () => {
    const doc = buildOpenApi({ ...env, PAY_TO: PAY } as Env) as {
      paths: Record<string, { post?: { summary?: string; description?: string; responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, { description?: string }> } }> }> } }>;
    };
    const topup = doc.paths["/api/chat/topup"]!.post!;
    // $2 = 15 messages at the default 7.5 credits/USD rate — visible pre-payment in summary, description, and the credits field.
    expect(topup.summary).toContain("$2.00 buys 15 coaching messages");
    expect(topup.description).toMatch(/block of 15 message credits/);
    expect(topup.responses!["200"]!.content!["application/json"]!.schema!.properties!.credits!.description).toContain("15");
    // ask discloses that an off-topic / safety-withheld reply is still charged (the session's surprise).
    expect(doc.paths["/api/chat/ask"]!.post!.description).toMatch(/STILL charged/);
  });
});
