/**
 * Newsletter send — access-gated (redacted). Sends a published blog post (by slug, built
 * from the live /blog/posts.json manifest) OR a custom {subject, html} as a Resend Broadcast to the
 * subscriber audience. Resend appends the unsubscribe footer. Mounted after the access gate.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { dispatchHtml, resendSendBroadcast } from "../newsletter/resend";

export const newsletterRoutes = new Hono<{ Bindings: Env }>();

const SITE = "https://ishtar.numetal.xyz";

const sendSchema = z.object({
  slug: z.string().min(1).max(120).optional(),
  subject: z.string().min(1).max(200).optional(),
  html: z.string().min(1).max(100_000).optional(),
  allowRawHtml: z.boolean().optional(),
});

/**
 * Minimal email-HTML hardening for the explicit raw-HTML escape hatch. Strips active content
 * (script/style/iframe/object/embed/link/meta) plus inline `on*=` event handlers and
 * javascript:/vbscript:/data: URLs. This is NOT a full HTML sanitizer — the trusted path is the
 * slug-rendered `dispatchHtml`; this only blunts the obvious injection vectors on the opt-in path,
 * because the email goes out from our verified domain and a leaked key must not become a phishing gun.
 */
export function sanitizeEmailHtml(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*(?:javascript|vbscript|data):[^"']*\2/gi, "$1=$2#$2")
    .replace(/(href|src)\s*=\s*(?:javascript|vbscript|data):[^\s>]+/gi, "$1=#");
}

newsletterRoutes.post("/newsletter/send", async (c) => {
  const parsed = sendSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "slug, or {subject, html}, required" }, 400);
  let { subject, html } = parsed.data;
  const { slug, allowRawHtml } = parsed.data;
  const rawHtmlProvided = !!html; // caller-supplied HTML (vs. trusted slug render)

  if (slug && (!subject || !html)) {
    const r = await fetch(`${SITE}/blog/posts.json`, { headers: { accept: "application/json" } });
    if (!r.ok) return c.json({ error: "could not read /blog/posts.json" }, 502);
    const posts = (await r.json().catch(() => [])) as Array<{ slug: string; title: string; description: string }>;
    const post = posts.find((p) => p.slug === slug);
    if (!post) return c.json({ error: `no published post with slug "${slug}"` }, 404);
    subject = subject || `Ishtar — ${post.title}`;
    html = html || dispatchHtml({ title: post.title, description: post.description, url: `${SITE}/blog/${slug}` });
  }
  if (!subject || !html) return c.json({ error: "provide slug, or both subject and html" }, 400);

  // The raw-HTML path is an injection/phishing surface (sent from our verified domain). Require an
  // explicit opt-in and sanitize it; the slug-rendered path stays trusted and untouched.
  if (rawHtmlProvided) {
    if (!allowRawHtml) return c.json({ error: "raw html requires allowRawHtml:true — prefer {slug}" }, 400);
    html = sanitizeEmailHtml(html);
  }

  const res = await resendSendBroadcast(c.env, { subject, html });
  if (!res.ok) return c.json({ ok: false, error: res.reason, broadcastId: res.broadcastId }, 502);
  return c.json({ ok: true, broadcastId: res.broadcastId, subject });
});
