import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchHtml, docReadyEmail, resendAddContact, resendSend, resendSendBroadcast } from "../src/newsletter/resend";
import type { Env } from "../src/env";

const cfg = { RESEND_API_KEY: "re_test", RESEND_AUDIENCE_ID: "aud_1", NEWSLETTER_FROM: "Ishtar <ishtar@numetal.xyz>" } as Env;

afterEach(() => vi.restoreAllMocks());

describe("dispatchHtml", () => {
  it("includes the title, description and read link, and escapes HTML", () => {
    const h = dispatchHtml({ title: "A <b>post</b>", description: "x & y", url: "https://ishtar.numetal.xyz/blog/p" });
    expect(h).toContain("A &lt;b&gt;post&lt;/b&gt;");
    expect(h).toContain("x &amp; y");
    expect(h).toContain("https://ishtar.numetal.xyz/blog/p");
  });
});

describe("resendAddContact", () => {
  it("no-ops (skipped) when Resend isn't configured", async () => {
    expect((await resendAddContact({} as Env, "a@b.com")).skipped).toBe(true);
  });
  it("posts the contact to the audience when configured", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "c1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await resendAddContact(cfg, "a@b.com");
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("/audiences/aud_1/contacts");
    expect(JSON.parse(String(init.body))).toMatchObject({ email: "a@b.com", unsubscribed: false });
  });
});

describe("docReadyEmail", () => {
  it("is in Ishtar's voice and carries the agents-not-people line", () => {
    const m = docReadyEmail();
    expect(m.subject).toMatch(/dating doc/i);
    expect(m.html).toContain("bound to your wallet");
    expect(m.html.toLowerCase()).toContain("agent");
    expect(m.text.toLowerCase()).toContain("agent");
    expect(m.text).toContain("Ishtar");
  });
  it("greets by display name when given (escaped)", () => {
    const m = docReadyEmail({ displayName: "A <b>x</b>" });
    expect(m.html).toContain("A &lt;b&gt;x&lt;/b&gt;");
  });
});

describe("resendSend (transactional)", () => {
  it("no-ops (skipped) when RESEND_API_KEY is unset", async () => {
    expect((await resendSend({} as Env, { to: "a@b.com", subject: "s", text: "t" })).skipped).toBe(true);
  });
  it("posts a single email to /emails with from/to/subject when configured", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "e1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await resendSend(cfg, { to: "a@b.com", subject: "Hi", html: "<p>h</p>", text: "h" });
    expect(r.ok).toBe(true);
    expect(r.id).toBe("e1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("/emails");
    expect(JSON.parse(String(init.body))).toMatchObject({ from: "Ishtar <ishtar@numetal.xyz>", to: "a@b.com", subject: "Hi" });
  });
  it("fails soft (never throws) when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const r = await resendSend(cfg, { to: "a@b.com", subject: "s", text: "t" });
    expect(r.ok).toBe(false);
  });
});

describe("resendSendBroadcast", () => {
  it("fails soft when not configured", async () => {
    expect((await resendSendBroadcast({} as Env, { subject: "s", html: "<p>h</p>" })).ok).toBe(false);
  });
  it("creates a broadcast then sends it", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ id: "b1" }), { status: String(url).endsWith("/broadcasts") ? 201 : 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await resendSendBroadcast(cfg, { subject: "Hi", html: "<p>h</p>" });
    expect(r.ok).toBe(true);
    expect(r.broadcastId).toBe("b1");
    expect(calls.some((u) => u.endsWith("/broadcasts"))).toBe(true);
    expect(calls.some((u) => u.includes("/broadcasts/b1/send"))).toBe(true);
  });
});
