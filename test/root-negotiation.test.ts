/**
 * The API root (GET /) is content-negotiated: a browser gets a human HTML front-door page, while
 * agents/bots/LLMs/curl get the JSON service index. This pins that a human view never hides the
 * machine surface — the JSON index (and every discovery link) stays reachable for non-browser clients.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

async function root(accept?: string): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {};
  if (accept !== undefined) headers.accept = accept;
  const r = await worker.fetch(new Request("https://api.ishtar.numetal.xyz/", { headers, cf: { country: "US" } }), env, ctx);
  await waitOnExecutionContext(ctx);
  return r;
}

describe("API root content negotiation", () => {
  it("a browser (Accept: text/html) gets the human HTML front-door — with every machine surface linked", async () => {
    const r = await root("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect((r.headers.get("vary") ?? "").toLowerCase()).toContain("accept"); // caches must not cross wires
    const html = await r.text();
    expect(html).toContain("api.ishtar.numetal.xyz");
    // the HTML must point machines at the JSON + discovery surfaces, so a crawler that renders it still finds them
    expect(html).toContain("/openapi.json");
    expect(html).toContain("/skill");
    expect(html).toContain("/llms-full.txt");
    expect(html).toContain("Accept: application/json");
  });

  it("a bot (Accept: application/json) gets the JSON service index, enriched with discovery links", async () => {
    const r = await root("application/json");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const j = (await r.json()) as Record<string, string>;
    expect(j.service).toBe("Ishtar");
    expect(j.openapi).toContain("/openapi.json");
    expect(j.skill).toContain("/skill");
  });

  it("curl (*/*) and clients with NO Accept default to JSON — the machine representation", async () => {
    for (const accept of ["*/*", undefined]) {
      const r = await root(accept);
      expect(r.headers.get("content-type"), `accept=${accept}`).toContain("application/json");
      expect(((await r.json()) as { service: string }).service).toBe("Ishtar");
    }
  });
});
