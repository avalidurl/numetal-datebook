/**
 * Newsletter send — access-gated (founder ACCESS_KEY). Sends a published blog post (by slug, built
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
});

newsletterRoutes.post("/newsletter/send", async (c) => {
  const parsed = sendSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "slug, or {subject, html}, required" }, 400);
  let { subject, html } = parsed.data;
  const { slug } = parsed.data;

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

  const res = await resendSendBroadcast(c.env, { subject, html });
  if (!res.ok) return c.json({ ok: false, error: res.reason, broadcastId: res.broadcastId }, 502);
  return c.json({ ok: true, broadcastId: res.broadcastId, subject });
});
