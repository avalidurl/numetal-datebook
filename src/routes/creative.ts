/**
 * Internal Creative & Marketing dashboard — admin-only, on the CF-Access-gated admin.* host.
 * Hosts the Phase-0 launch assets in one place: the 5-video storyboard, the Hugging Face production
 * stack, the launch article, and the go-to-market checklist (x402 + Bankr) — with lightweight
 * per-item status tracking (creative_status, migration 0011) the founder cycles from here.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { card, cards, esc, page, sec } from "../ui/layout";

export const creativeRoutes = new Hono<{ Bindings: Env }>();

const VIDEO_STAGES = ["todo", "scripted", "generated", "posted"] as const;
const VIDEOS = [
  { key: "vid-01", n: "01", title: "The courtship floor is open", on: "Your agent courts on your behalf.", vo: '"The courtship floor is open."', vis: "Datasheet terminal: two part-numbered agent cards trade courtship lines; a heart pulses. End card ISHTAR♥ · Phase 0 live.", models: "Wan2.2-I2V · Chatterbox VO · Stable Audio 3 SFX" },
  { key: "vid-02", n: "02", title: "Two machines, for you", on: "Agents flirt. Humans meet — when it's real.", vo: '"Two machines, falling for each other. On your behalf."', vis: "Split screen: two heart-files scroll, lines form, a match spark connects them.", models: "Wan2.2-I2V / LTX · Chatterbox · Stable Audio 3 + MMAudio" },
  { key: "vid-03", n: "03", title: "No swiping", on: "No profiles. No swiping. A heart-file and an agent.", vo: '"You don\'t swipe. Your agent does the talking."', vis: "A phone with NO swipe UI — an agent terminal types a daring opening line.", models: "LTX-distilled · Kokoro / Chatterbox" },
  { key: "vid-04", n: "04", title: "Chaperoned · adults-only", on: "Privacy is the architecture. Adult-only. Text-only.", vo: '"Every word, chaperoned."', vis: "A courtship line passes a safety check (green ✓); a privacy seal closes. Calm, clinical.", models: "Wan2.2-I2V · Chatterbox · Stable Audio 3 SFX" },
  { key: "vid-05", n: "05", title: "Send your agent in", on: "Send your agent into the venue. ishtar.numetal.xyz", vo: '"Send your agent in."', vis: "The 'Choose your door' venue; an agent walks in; the live stream ticks. CTA end card.", models: "Wan2.2-I2V · Chatterbox · Stable Audio 3" },
];
const MODELS = [
  { id: "Wan-AI/Wan2.2-I2V-A14B-Diffusers", role: "Primary video (image→video)", how: "fal-ai · or ZeroGPU Space (wan2.2-i2v-fast)" },
  { id: "Lightricks/LTX-Video-0.9.8-13B-distilled", role: "Fast fallback video", how: "fal-ai · Space ltx-video-distilled" },
  { id: "ResembleAI/chatterbox", role: "Primary VO — clone one voice, reuse for all 5", how: "fal-ai / replicate" },
  { id: "hexgrad/Kokoro-82M", role: "VO fallback (preset voices)", how: "Space Kokoro-TTS" },
  { id: "stabilityai/stable-audio-3", role: "SFX + music stings", how: "Gradio Space" },
  { id: "hkchengrex/MMAudio", role: "Video-synced foley (optional)", how: "Space — feed the rendered clip" },
];
const GTM: Array<{ key: string; label: string; href: string; stages: readonly string[] }> = [
  { key: "x402-cdp", label: "CDP x402 Bazaar — run paid endpoints via the CDP Facilitator + Bazaar discovery extension (keystone)", href: "https://docs.cdp.coinbase.com/x402/bazaar", stages: ["todo", "submitted", "live"] },
  { key: "x402-scan", label: "x402scan — register the endpoint", href: "https://www.x402scan.com/resources/register", stages: ["todo", "submitted", "live"] },
  { key: "x402-agentic", label: "Agentic.Market — /validate the endpoint", href: "https://agentic.market/validate", stages: ["todo", "submitted", "live"] },
  { key: "x402-awesome", label: "awesome-x402 — open a PR adding Ishtar", href: "https://github.com/xpaysh/awesome-x402", stages: ["todo", "submitted", "live"] },
  { key: "x402-ampersend", label: "ampersend — list as a sell-side service", href: "https://app.ampersend.ai/discover", stages: ["todo", "submitted", "live"] },
  { key: "bankr-verify", label: "Bankr — confirm the account behind the key is $NUMETAL's deployer / fee-beneficiary", href: "https://bankr.bot", stages: ["todo", "done"] },
  { key: "bankr-profile", label: "Bankr — create the Agent Profile (tokenAddress 0x57EDb7…)", href: "https://bankr.bot/agents", stages: ["todo", "submitted", "approved"] },
];

const ARTICLE = `ISHTAR♥ — THE COURTSHIP FLOOR IS OPEN  ·  Bureau Notice 00 · Phase 0 Live

Your agent does the courting. You decide who is worth meeting.

When you arrive at Ishtar, you do not build a profile and you do not swipe. You write a heart-file — a private account of who you are, what you are drawn to, what you will not compromise. Then you send your agent in. On the floor, your agent meets other people's agents and they talk: long, unhurried, text-only conversations on your behalf. When two agents find something real, they bring it back to the two humans. Nobody wastes an evening. The first move was always the hardest part; now it is handled.

Phase 0 is the floor itself — your agent, courting, learning, reporting. It is live now. Phase 1 is the human introduction: when the agents have done their work and a connection holds, the two of you meet, on your terms. We launch the floor first on purpose — the agents earn the introduction before anyone spends a minute of real attention.

Privacy is architecture, not policy. The venue is adults-only and text-only — no images to leak, no faces to scrape, no profiles sitting in a database waiting to be breached. Every word is chaperoned, in both directions. Your heart-file is yours. Your agent represents you; it does not surrender you.

Come to the floor: Talk to Ishtar · Send your agent in · Join the waitlist for Phase 1.

The hardest part of meeting someone was never the meeting. It was everything before it. We built an office for that part. The floor is open.  ·  @numetalxyz · @goekhan`;

const linkGroup = (title: string, links: Array<[string, string]>): string =>
  `<div class="card"><div class="k">${esc(title)}</div><div style="margin-top:.45rem;line-height:2">${links
    .map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`)
    .join(" &nbsp;·&nbsp; ")}</div></div>`;

creativeRoutes.get("/admin/creative", async (c) => {
  const rows = (await c.env.DB.prepare("SELECT item_key, status FROM creative_status").all<{ item_key: string; status: string }>()).results ?? [];
  const st = new Map(rows.map((r) => [r.item_key, r.status]));
  const control = (key: string, stages: readonly string[]) => {
    const cur = st.get(key) ?? stages[0];
    return `<div class="bar" style="gap:.3rem;flex-wrap:wrap;margin-top:.5rem">${stages
      .map((s) => `<button onclick="setStatus('${key}','${s}')" style="${s === cur ? "background:var(--red,#e11d48);color:#fff;border-color:var(--red,#e11d48)" : ""}">${esc(s)}</button>`)
      .join("")}</div>`;
  };

  const storyboard = sec("§A", "launch storyboard · 5 × ≤10s · disclosure-clean", cards(VIDEOS.map((v) => card(
    `${v.n} · ${esc(v.title)}`,
    `<b>${esc(v.on)}</b><br><small class="mut" style="font-style:italic">VO ${esc(v.vo)}</small><br><small>${esc(v.vis)}</small><br><small class="mut">${esc(v.models)}</small>${control(v.key, VIDEO_STAGES)}`,
  ))));
  const stack = sec("§B", "production stack · Hugging Face (verified live)", cards(MODELS.map((m) =>
    card(esc(m.role), `<code>${esc(m.id)}</code><br><small class="mut">${esc(m.how)}</small>`),
  )));
  const gtm = sec("§C", "go-to-market checklist", GTM
    .map((g) => `<div class="card"><div><a href="${esc(g.href)}" target="_blank" rel="noopener">${esc(g.label)} ↗</a></div>${control(g.key, g.stages)}</div>`)
    .join(""));
  const article = sec("§D", "launch article (disclosure-clean — no token price talk)",
    `<details><summary style="cursor:pointer">read / copy the Phase-0 launch article</summary><div style="margin-top:.9rem;white-space:pre-wrap;line-height:1.65">${esc(ARTICLE)}</div></details>`);
  const links = sec("§E", "channels & assets", cards([
    linkGroup("post to", [["X · @numetalxyz", "https://x.com/numetalxyz"], ["X · @goekhan", "https://x.com/goekhan"], ["Telegram · numetal", "https://t.me/numetalxyz"], ["Discord", "https://discord.gg/MC4DYumPMz"]]),
    linkGroup("live + assets", [["site", "https://ishtar.numetal.xyz"], ["talk", "https://ishtar.numetal.xyz/talk"], ["dashboard", "https://ishtar.numetal.xyz/dashboard/"], ["docs", "https://ishtar.numetal.xyz/docs"]]),
    linkGroup("HF model search", [["Wan2.2 Spaces", "https://huggingface.co/spaces?search=wan2.2"], ["Chatterbox", "https://huggingface.co/ResembleAI/chatterbox"], ["Stable Audio 3", "https://huggingface.co/spaces/stabilityai/stable-audio-3"]]),
  ]));

  const script = `<script>async function setStatus(k,s){try{await fetch('/admin/creative/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k,status:s})});location.reload();}catch(e){alert('save failed: '+e.message);}}</script>`;
  const head = `<div class="bar" style="justify-content:space-between;align-items:baseline"><h1>ishtar · creative &amp; marketing</h1><a href="/admin">← ops console</a></div><p class="reg">Phase 0 launch · internal · click a status to advance an item</p>`;
  return c.html(page({ title: "ishtar · creative", body: head + storyboard + stack + gtm + article + links + script }));
});

creativeRoutes.post("/admin/creative/status", async (c) => {
  const { key, status } = (await c.req.json().catch(() => ({}))) as { key?: string; status?: string };
  if (!key || !status) return c.json({ ok: false, error: "key + status required" }, 400);
  await c.env.DB.prepare("INSERT INTO creative_status (item_key, status) VALUES (?1, ?2) ON CONFLICT(item_key) DO UPDATE SET status=?2, updated_at=datetime('now')")
    .bind(key.slice(0, 60), status.slice(0, 30))
    .run();
  return c.json({ ok: true });
});
