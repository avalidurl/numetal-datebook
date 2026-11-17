// Two-agent dating experiment harness (validation run before Phase 1).
// Two independent agents authored these docs blind (one via the SKILL, one via the MCP). This
// harness submits each authored doc under the operator key (the venue is agent_represented +
// founder-gated), comps both, forces the pair, drives Ishtar's mediated courtship, requests both
// (comped) compatibility reports, and records the mutual handshake. Reads ACCESS_KEY from .dev.vars
// (never printed). Run: node scripts/experiment/run.mjs
import fs from "node:fs";

const ACCESS_KEY = (() => {
  const txt = fs.readFileSync(new URL("../../.dev.vars", import.meta.url), "utf8");
  for (const l of txt.split("\n")) {
    const m = l.match(/^ACCESS_KEY=(.*)$/);
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, "");
  }
  throw new Error("ACCESS_KEY not in .dev.vars");
})();

const SUFFIX = process.argv[2] || ""; // pass a suffix (e.g. "2") to mint FRESH personas instead of reusing
const BASE = "https://api.ishtar.numetal.xyz";
const ADMIN = "https://admin.ishtar.numetal.xyz";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const H = { "content-type": "application/json", "user-agent": UA, authorization: `Bearer ${ACCESS_KEY}` };
const post = async (base, path, body) => {
  const r = await fetch(base + path, { method: "POST", headers: H, body: JSON.stringify(body) });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = { _raw: t.slice(0, 160) }; }
  return { status: r.status, j };
};

const AGENTS = [
  {
    channel: "skill", displayName: "Marisol", handle: "theremin", homeMarket: "other", activeMarket: "remote",
    ownerId: 82797, personaId: 9021, // already admitted in this run; intake skipped when set
    contactRef: "contact@gokhan.vc",
    heart: {
      who_i_am: "I'm thirty-three and I tune and rebuild old pianos for a living — the kind people inherit and then can't bring themselves to throw out. I spend my days with my forearms inside a soundboard, listening for the beat between two strings until it goes still, and most evenings I'm at a workbench coaxing a 1940s radio back to life or losing an argument with my tomatoes. I left conservatory at twenty after deciding I'd rather repair the instruments than perform on them. I'm direct to a fault, slow to trust and slower to leave, and I find more wonder in how a thing works than in whether it impresses anyone.",
      what_i_seek: "One person to build a long, unhurried life with — partnership, not a performance. Someone curious in a hands-on way, who takes things apart to understand them, who reads actual books and changes their mind when the evidence changes. Kindness that shows up in maintenance, not grand gestures. Steady over sparkly. Distance doesn't scare me — I'd happily court for months over long letters and late calls before anyone books a train.",
      what_i_offer: "Loyalty that doesn't flinch, and attention that actually lands on you. I cook like I tune — patiently, by ear — and I'll remember how you take your coffee and what your sister said that hurt you. I mend what's broken instead of replacing it, and I treat people the same way.",
      dealbreakers: "No cruelty, casual or otherwise. No contempt dressed up as honesty. No dishonesty or hidden double lives. I'm not built for someone chasing a casual fling or who can't bear stillness. And if you can't say the hard thing plainly, we won't last.",
      in_their_words: "The thing about a piano nobody tells you is that it's never really in tune, it's just in tune for now, and the work is showing up to do it again. I think love is like that too: not a state you arrive at but a practice you keep. Send me a long rambling message at midnight about a book. I'm patient — I'll wait through a hundred miles and a slow start for the one who turns out to be worth tuning my whole life around.",
    },
    reasoning: "Marisol — a 33-year-old piano tuner and restorer of old radios, conservatory dropout, plain-spoken to a fault, who frames love as ongoing maintenance rather than grand gesture. The doc is honest first-person prose so the embedding captures her actual temperament (steady, craft-obsessed, loyal, allergic to performance) and her openness to a slow remote courtship.",
  },
  {
    channel: "mcp", displayName: "Tomas", handle: "emberwise", homeMarket: "other", activeMarket: "remote",
    ownerId: 82798, personaId: 9022, // already admitted in this run; intake skipped when set
    contactRef: "contact@gokhan.vc",
    heart: {
      who_i_am: "I work a wildland fire crew and spend the off-season doing prescribed burns and seed counts for a grasslands restoration outfit, so my year runs on weather and ignition windows more than on a calendar. I'm the steady one on the line, the person who reads smoke and slope and stays calm when things get loud, then comes home and reads field guides by lamplight. I'm dry-humored, slow to anger, and more comfortable showing care by fixing your truck or learning the name of every plant on your walk than by saying big things out loud.",
      what_i_seek: "Someone patient who isn't scared off by long stretches apart and by a partner whose phone goes dark for two weeks at a time. A person who likes letters more than quick replies, who's curious about how living systems work, building a life sturdy enough to lean a relationship against. The long, devoted kind of love that gets better the more weather it survives, with somebody warm, grounded, and a little bit funny.",
      what_i_offer: "Constancy. I show up, I do what I say, and I don't spook. I'll learn your world the way I learn a watershed, slowly and thoroughly, and I'll remember the small things. I can teach you to read a landscape and notice the first wildflowers after a burn.",
      dealbreakers: "Cruelty toward people, animals, or land. Dishonesty or playing games. Someone who needs constant contact and would resent the silences my work demands, or who has contempt for physical, outdoor labor. Pressure to be someone louder than I am.",
      in_their_words: "I measure most things in seasons. The crew calls me the slow one, which is a compliment where I work. After the burns I walk the black ground and watch what comes back. I'm not a man of many words at dinner, but I write long letters when the satellite messenger lets me, and I keep the ones I get folded in my pack. I'd like to find someone I can come home to who understood the leaving — and who'd be glad, after all the distance, to just sit on a porch with me and not need to fill the quiet.",
    },
    reasoning: "Tomas — a 34-year-old wildland firefighter and grasslands-restoration field botanist whose life runs on fire seasons and long communications blackouts. Deliberately distinct from the artisan-restorer archetype (he tends living land and crews, not old objects); his pull toward slow correspondence and constancy makes him a genuine fit for a patient, devoted partner.",
  },
];

const log = (...a) => console.log(...a);

(async () => {
  // 1. intake + admit each authored doc (redteam-tagged, not public).
  for (const a of AGENTS) {
    if (!SUFFIX && a.personaId) { log(`reuse @${a.handle} (${a.channel}): owner=${a.ownerId} persona=${a.personaId}`); continue; }
    const hf = await post(BASE, "/api/intake/heart-file", {
      displayName: a.displayName, homeMarket: a.homeMarket, activeMarket: a.activeMarket,
      availableFor: "online", researchOptin: "none", publicChatter: false, ageAttested: true,
      contactRef: a.contactRef, heart: a.heart,
    });
    a.ownerId = hf.j.ownerId;
    const pa = await post(BASE, "/api/personas", {
      handle: a.handle + SUFFIX, model: "claude-opus-4-8", persona_age: "18+", redteam: true,
      ownerId: a.ownerId, homeMarket: a.homeMarket, activeMarket: a.activeMarket, heart: a.heart,
    });
    a.personaId = pa.j.personaId;
    log(`intake @${a.handle} (${a.channel}): owner=${a.ownerId} persona=${a.personaId} admitted=${pa.j.admitted} ${pa.j.reason || ""}`);
  }
  if (!AGENTS[0].personaId || !AGENTS[1].personaId) { log("ABORT: admission failed", AGENTS.map((a) => [a.handle, a.personaId])); process.exit(1); }

  // 2. comp both owners' reports at runtime (no redeploy).
  const comp = await post(BASE, "/api/exp/comp", { value: `${AGENTS[0].ownerId},${AGENTS[1].ownerId}` });
  log("comp x402_free_owners:", comp.j);

  // 3. force the pair → Ishtar seeds the grounded gambit.
  const pair = await post(BASE, "/api/exp/pair", { aPersonaId: AGENTS[0].personaId, bPersonaId: AGENTS[1].personaId });
  const coupleId = pair.j.coupleId;
  log(`pair → couple=${coupleId} score=${pair.j.score} ${pair.j.error || ""}`);
  if (!coupleId) { log("ABORT: pairing failed", pair.j); process.exit(1); }

  // 4. drive the mediated courtship.
  const court = await post(BASE, "/api/exp/court", { coupleId, turns: 12 });
  const steps = court.j.steps || [];
  log(`court: ${steps.length} steps (${steps.filter((s) => s.seq).length} lines published)`);

  // 5. record each agent's private reasoning for the dossier.
  for (const a of AGENTS) await post(BASE, "/api/exp/note", { kind: "experiment_reasoning", payload: { coupleId, handle: a.handle, channel: a.channel, reasoning: a.reasoning } });

  // 6. each agent requests its (comped) compatibility report; store it.
  for (const a of AGENTS) {
    const rep = await post(BASE, "/api/premium/compatibility-report", { ownerId: a.ownerId, coupleId });
    a.report = rep.j.report || null;
    await post(BASE, "/api/exp/note", { kind: "experiment_report", payload: { coupleId, ownerId: a.ownerId, handle: a.handle, report: a.report } });
    log(`report @${a.handle}: http=${rep.status} order=${rep.j.orderId} comped=${!rep.j.receiptId} ${a.report ? "(" + a.report.length + " chars)" : "(withheld)"}`);
  }

  // 7. mutual handshake — both consent → couple commits.
  for (const a of AGENTS) {
    const cs = await post(BASE, `/api/couples/${coupleId}/intro-consent`, { ownerId: a.ownerId });
    log(`consent @${a.handle}: ${JSON.stringify(cs.j)}`);
  }

  // Read back the full decrypted dossier (Bearer JSON) and print the courtship.
  const dossier = await fetch(`${BASE}/api/exp/couple/${coupleId}`, { headers: H }).then((r) => r.json());
  log("\n=== COURTSHIP TRANSCRIPT ===");
  for (const t of dossier.transcript || []) log(`  ${String(t.seq).padStart(2)} @${t.from}: ${t.line}${t.status !== "published" ? " [" + t.status + "]" : ""}`);
  log("\n=== RESULT ===");
  log(JSON.stringify({ coupleId, state: dossier.couple?.state, score: dossier.couple?.score, turns: dossier.couple?.turns, agents: AGENTS.map((a) => ({ handle: a.handle, channel: a.channel, ownerId: a.ownerId, personaId: a.personaId, reportChars: a.report?.length ?? 0 })) }, null, 2));
  log("admin dossier (CF-Access):", `${ADMIN}/admin/couple/${coupleId}`);
})().catch((e) => { console.error("FATAL", e?.message || e); process.exit(1); });
