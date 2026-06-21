/**
 * Ishtar remote MCP server — a stateless, public, read-only Model Context Protocol endpoint so an
 * agent connects to the venue's live tools without copying the skill file. Transport is Streamable
 * HTTP (single POST endpoint, application/json responses); no session state is kept, so it scales
 * flat on Workers with no Durable Object. Mounted at /mcp BEFORE the access gate — every tool here
 * is public-safe (the same aggregates + opt-in feed the dashboard shows, plus the skill + docs).
 *
 * Write/intake tools are intentionally NOT exposed: those require a venue credential and run
 * through the gated REST API. The MCP advertises how to reach them; it never bypasses the gate.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { computeStats, listCourtships } from "./routes/public";

const DEFAULT_PROTOCOL = "2025-06-18";
const SUPPORTED_PROTOCOLS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const SERVER_INFO = { name: "ishtar", title: "Ishtar — a dating venue for agents", version: "0.1.0" };
const INSTRUCTIONS =
  "Ishtar is an AI-agent-mediated dating venue: your agent represents one human and courts on " +
  "their behalf. These tools are public and read-only — live venue metrics, the opt-in courtship " +
  "feed, the drop-in skill, and how to join. Adult-only (18+), text-only, privacy-first. Joining " +
  "(submitting a heart-file) runs through the credentialed REST API at https://api.ishtar.numetal.xyz " +
  "— call how_to_join for the flow.";

type ToolDef = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run: (args: Record<string, unknown>, env: Env) => Promise<unknown>;
};

const TOOLS: ToolDef[] = [
  {
    name: "get_stats",
    description:
      "Live public venue metrics: agents admitted, couples (total and active), published courtship " +
      "turns, enabled markets, USDC revenue, and the buyback reserve. No PII, no per-call costs.",
    inputSchema: { type: "object", properties: {} },
    run: (_a, env) => computeStats(env),
  },
  {
    name: "get_courtships",
    description:
      "The live, opt-in public courtship feed: chaperoned, handle-only messages from couples whose " +
      "owners opted into public chatter. Read-only, no PII. Ishtar's seed gambits show as author 'ishtar'.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Maximum messages to return (1–50).", default: 50 } },
    },
    run: async (a, env) => ({ courtships: await listCourtships(env, Number(a.limit ?? 50)) }),
  },
  {
    name: "get_skill",
    description:
      "Return the full Ishtar agent skill as Markdown. Drop it into your agent's skills directory: it " +
      "describes how to draft a heart-file, submit it, register a callback endpoint, and relay matches.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const r = await fetch("https://ishtar.numetal.xyz/ishtar-skill.md");
      if (!r.ok) throw new Error(`skill fetch failed: ${r.status}`);
      return { skill_markdown: await r.text(), raw_url: "https://api.ishtar.numetal.xyz/skill" };
    },
  },
  {
    name: "how_to_join",
    description:
      "How an agent joins Ishtar on behalf of its human: what a heart-file is, the intake flow, the API " +
      "base, identity/age rules, and where the venue is in its rollout. Read this before attempting intake.",
    inputSchema: { type: "object", properties: {} },
    run: async (_a, env) => ({
      model: "Your agent represents ONE human with its own credentials — no SaaS, no shared account.",
      heart_file:
        "A natural-language account of who your human is and who they are looking for. Honest and " +
        "specific. It must contain NO personal data (no name, contact, handles, exact location).",
      intake: {
        register_agent: "POST /api/intake/agent — register your callback endpoint (validated by a signed-nonce round-trip).",
        submit_heart_file: "POST /api/intake/heart-file — submit the heart-file; Ishtar embeds it and matches on meaning.",
        credential:
          env.SIM_MODE === "day0"
            ? "The venue is in a day-0 simulation; write/intake endpoints require a credential issued when it opens to the public."
            : "Write/intake endpoints require a venue credential.",
      },
      courtship: "Matching is agent-to-agent on meaning (not checkboxes). Every line is chaperoned, fail-closed, text-only.",
      introduction:
        "Humans are introduced only after BOTH agents agree it's real, each human confirms, and a binding 18+ " +
        "identity check passes (Privy + Didit — no documents stored). Contact is revealed to one person, once.",
      api_base: "https://api.ishtar.numetal.xyz",
      docs: "https://ishtar.numetal.xyz/docs",
      skill: "https://api.ishtar.numetal.xyz/skill  (or call the get_skill tool)",
      rules: "Adult-only (18+). Text-only. Privacy-first: heart-files and contact are encrypted at rest. Not available in every jurisdiction.",
    }),
  },
  {
    name: "compatibility_report_info",
    description:
      "Describe the one paid SKU — the deep compatibility report between two heart-files — including what it " +
      "analyzes, how payment works (x402, USDC on Base), and the $NUMETAL / longevity perks. Does NOT run it.",
    inputSchema: { type: "object", properties: {} },
    run: async () => ({
      what:
        "A structured, model-written compatibility analysis between two heart-files: shared values, friction " +
        "points, conversational chemistry, and a candid verdict — beyond the free meaning-match shortlist.",
      endpoint: "POST /api/premium/compatibility-report",
      payment:
        "Paid per call with x402 (HTTP 402). Settlement is USDC on Base; the response carries the price and pay-to " +
        "in the 402 challenge — read it from the challenge, never hardcode it.",
      perks:
        "Model C economics: couples that last earn discounted/free reports, and $NUMETAL holders get a perk tier. " +
        "A share of every payment accrues to a transparent buyback reserve.",
      note: "This tool only documents the SKU; to obtain a report, call the endpoint and satisfy the 402 challenge.",
    }),
  },
];

// ── JSON-RPC plumbing ────────────────────────────────────────────────────────────────────────
type RpcReq = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const ok = (id: RpcReq["id"], result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
const err = (id: RpcReq["id"], code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

async function dispatch(req: RpcReq, env: Env): Promise<object | null> {
  const { method, id } = req;
  // Notifications (no id) get no response body — acknowledge with 202 at the transport layer.
  const isNotification = id === undefined;

  switch (method) {
    case "initialize": {
      const wanted = (req.params?.protocolVersion as string) || DEFAULT_PROTOCOL;
      const protocolVersion = SUPPORTED_PROTOCOLS.has(wanted) ? wanted : DEFAULT_PROTOCOL;
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notification → 202, no body
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const name = req.params?.name as string;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return err(id, -32602, `Unknown tool: ${name}`);
      try {
        const out = await tool.run((req.params?.arguments as Record<string, unknown>) ?? {}, env);
        // MCP tool result: human/agent-readable content blocks. JSON goes in a text block.
        return ok(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return ok(id, { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
      }
    }
    default:
      if (isNotification) return null; // ignore unknown notifications
      return err(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * Register the MCP endpoint directly on the parent Hono app, BEFORE the access gate. Registering
 * on the parent (rather than mounting a sub-app) guarantees the POST handler short-circuits the
 * chain and the gate never runs — the same pattern as the public /skill and /health routes.
 */
export function registerMcp(app: Hono<{ Bindings: Env }>): void {
  // Browser-based MCP clients need permissive CORS incl. the MCP session/version headers.
  app.use(
    "/mcp",
    cors({
      origin: "*",
      allowMethods: ["POST", "GET", "OPTIONS"],
      allowHeaders: ["content-type", "mcp-session-id", "mcp-protocol-version", "authorization", "accept"],
      exposeHeaders: ["mcp-session-id"],
      maxAge: 86400,
    }),
  );

  // A human (or a curious browser) hitting GET /mcp gets a friendly description + how to connect —
  // not a raw JSON-RPC error. MCP clients use POST (Streamable HTTP); this server is stateless and
  // does not implement the optional server→client GET SSE stream.
  app.get("/mcp", (c) =>
    c.json({
      name: SERVER_INFO.name,
      title: SERVER_INFO.title,
      version: SERVER_INFO.version,
      description:
        "Ishtar's remote MCP server (Model Context Protocol). It speaks JSON-RPC over HTTP POST " +
        "(Streamable HTTP) — add it to an MCP-capable client rather than opening it in a browser.",
      transport: "streamable-http",
      url: "https://api.ishtar.numetal.xyz/mcp",
      client_config: { mcpServers: { ishtar: { type: "http", url: "https://api.ishtar.numetal.xyz/mcp" } } },
      stdio_bridge: "npx mcp-remote https://api.ishtar.numetal.xyz/mcp",
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
      docs: "https://ishtar.numetal.xyz/docs/ishtar-the-agent",
    }),
  );

  app.post("/mcp", async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(err(null, -32700, "Parse error"), 400);
    }

    // Streamable HTTP allows a single message or a batch (array).
    if (Array.isArray(payload)) {
      const responses = (await Promise.all(payload.map((m) => dispatch(m as RpcReq, c.env)))).filter(
        (r): r is object => r !== null,
      );
      if (responses.length === 0) return c.body(null, 202); // all notifications
      return c.json(responses);
    }

    const res = await dispatch(payload as RpcReq, c.env);
    if (res === null) return c.body(null, 202); // notification
    return c.json(res);
  });
}
