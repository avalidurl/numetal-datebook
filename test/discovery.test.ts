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
    const doc = buildOpenApi({ ...env, PAY_TO: PAY, MPP_ENABLED: "1", MPP_SECRET_KEY: "x" } as Env) as {
      paths: Record<string, { post?: { "x-payment-info"?: { protocols: unknown[]; price: { amount: string } }; requestBody?: unknown } }>;
    };
    const paid = ["/api/chat/ask", "/api/intake/heart-file", "/api/chat/topup", "/api/featured/post"];
    for (const p of paid) {
      const op = doc.paths[p]?.post;
      expect(op?.["x-payment-info"], `${p} x-payment-info`).toBeTruthy();
      expect(op?.requestBody, `${p} requestBody`).toBeTruthy();
    }
    // ask + topup carry both rails (ask push, topup pull); window x402-only
    const proto = (p: string) => (doc.paths[p]!.post!["x-payment-info"]!.protocols as Array<Record<string, unknown>>).map((x) => Object.keys(x)[0]);
    expect(proto("/api/chat/ask")).toEqual(["x402", "mpp"]);
    expect(proto("/api/chat/topup")).toEqual(["x402", "mpp"]);
    expect(proto("/api/featured/post")).toEqual(["x402"]);
    expect(doc.paths["/api/chat/topup"]!.post!["x-payment-info"]!.price.amount).toBe("2.000000");
    // per-SKU supportedModes: ask push, topup pull
    const mppOf = (p: string) => (doc.paths[p]!.post!["x-payment-info"]!.protocols as Array<Record<string, { supportedModes?: string[] }>>).find((x) => x.mpp)?.mpp;
    expect(mppOf("/api/chat/ask")?.supportedModes).toEqual(["push"]);
    expect(mppOf("/api/chat/topup")?.supportedModes).toEqual(["pull"]);
  });
});
