import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentRelayConfigured,
  isSafeDeliveryUrl,
  sendAgentRelay,
  signRelayBody,
  verifyRelaySignature,
  type AgentRelayPayload,
} from "../src/agentrelay/outbound";

describe("agent-relay: config gate", () => {
  it("is off unless AGENT_RELAY_ENABLED is truthy", () => {
    expect(agentRelayConfigured({})).toBe(false);
    expect(agentRelayConfigured({ AGENT_RELAY_ENABLED: "" })).toBe(false);
    expect(agentRelayConfigured({ AGENT_RELAY_ENABLED: "0" })).toBe(false);
    expect(agentRelayConfigured({ AGENT_RELAY_ENABLED: "1" })).toBe(true);
    expect(agentRelayConfigured({ AGENT_RELAY_ENABLED: "true" })).toBe(true);
    expect(agentRelayConfigured({ AGENT_RELAY_ENABLED: "on" })).toBe(true);
  });
});

describe("agent-relay: SSRF guard", () => {
  it("accepts public https (incl. a Tailscale Funnel hostname)", () => {
    expect(isSafeDeliveryUrl("https://agent.example.com/hooks/agent")).toBe(true);
    expect(isSafeDeliveryUrl("https://box.tailabc12.ts.net/hooks/agent")).toBe(true);
  });
  it("rejects http, localhost, private/loopback/metadata/CGNAT, .internal, and junk", () => {
    expect(isSafeDeliveryUrl("http://agent.example.com")).toBe(false);
    expect(isSafeDeliveryUrl("https://localhost/x")).toBe(false);
    expect(isSafeDeliveryUrl("https://127.0.0.1/x")).toBe(false);
    expect(isSafeDeliveryUrl("https://10.0.0.5/x")).toBe(false);
    expect(isSafeDeliveryUrl("https://192.168.1.10/x")).toBe(false);
    expect(isSafeDeliveryUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isSafeDeliveryUrl("https://172.16.9.9/x")).toBe(false);
    expect(isSafeDeliveryUrl("https://100.117.80.69/x")).toBe(false); // tailnet CGNAT
    expect(isSafeDeliveryUrl("https://ops.internal/x")).toBe(false);
    expect(isSafeDeliveryUrl("https://[::1]/x")).toBe(false);
    expect(isSafeDeliveryUrl("not-a-url")).toBe(false);
    expect(isSafeDeliveryUrl(null)).toBe(false);
  });
  it("does not false-block public hostnames that merely start with fc/fd", () => {
    expect(isSafeDeliveryUrl("https://fcbarcelona.com/x")).toBe(true);
    expect(isSafeDeliveryUrl("https://fdgroup.io/x")).toBe(true);
  });
});

describe("agent-relay: signature", () => {
  it("is deterministic 64-char hex and secret-dependent", async () => {
    const body = JSON.stringify({ v: 1, kind: "match", ownerId: 7, ts: 1, nonce: "n", subject: "s", text: "t" });
    const a = await signRelayBody("supersecretsupersecret", body);
    const b = await signRelayBody("supersecretsupersecret", body);
    const c = await signRelayBody("a-different-secret-value", body);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("agent-relay: consumer verifier (the reference an agent reimplements)", () => {
  it("round-trips: a signed body verifies; a tampered body / wrong secret / bad sig / no header do not", async () => {
    const body = JSON.stringify({ v: 1, kind: "match", ownerId: 9, url: "https://x/y", ts: 2, nonce: "z" });
    const secret = "supersecretsupersecret";
    const header = `sha256=${await signRelayBody(secret, body)}`;
    expect(await verifyRelaySignature(secret, body, header)).toBe(true);
    expect(await verifyRelaySignature(secret, body + " ", header)).toBe(false); // tampered body
    expect(await verifyRelaySignature("wrong-secret-wrong", body, header)).toBe(false);
    expect(await verifyRelaySignature(secret, body, "sha256=deadbeef")).toBe(false);
    expect(await verifyRelaySignature(secret, body, null)).toBe(false);
  });
});

describe("agent-relay: send fail-soft (short-circuits before any fetch)", () => {
  const payload: AgentRelayPayload = {
    v: 1,
    kind: "match",
    ownerId: 1,
    url: "https://ishtar.numetal.xyz/matches/?token=x",
    subject: "s",
    text: "t",
    ts: 1,
    nonce: "n",
  };
  it("no-ops when disabled (never sends per-owner data)", async () => {
    const r = await sendAgentRelay({}, "https://agent.example.com/h", "supersecretsupersecret", payload);
    expect(r).toEqual({ ok: false, reason: "agent-relay disabled" });
  });
  it("refuses an unsafe URL even when enabled", async () => {
    const r = await sendAgentRelay({ AGENT_RELAY_ENABLED: "1" }, "https://127.0.0.1/h", "supersecretsupersecret", payload);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("unsafe");
  });
  it("refuses a weak secret", async () => {
    const r = await sendAgentRelay({ AGENT_RELAY_ENABLED: "1" }, "https://agent.example.com/h", "short", payload);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("secret");
  });
  it("does not follow redirects — a 3xx is a failure, not a chased redirect (SSRF)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } })));
    const r = await sendAgentRelay({ AGENT_RELAY_ENABLED: "1" }, "https://agent.example.com/h", "supersecretsupersecret", payload);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("302");
  });
  afterEach(() => vi.unstubAllGlobals());
});
