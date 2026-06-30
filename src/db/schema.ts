/**
 * datebook D1 schema (Drizzle) — production-correct port of the day-0 scaffold.
 * Audit fixes baked in: chaperone verdict enum, research_optin, available_for,
 * idempotency UNIQUE keys, runtime settings, inference-cost + buyback ledgers,
 * access_denials, validated agent endpoints. Text-only; chaperone state machines
 * live in status columns.
 */
import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";

const now = sql`(datetime('now'))`;

/* ----------------------------------------------------------------- runtime config */
// Single source of truth for tunable knobs (admit cap, budgets) — read at request/
// cron time so raising the cap never needs a redeploy (audit: no hardcoded limits).
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(now),
});

/* ----------------------------------------------------------------- markets */
export const geoMarkets = sqliteTable("geo_markets", {
  id: text("id").primaryKey(), // bay_area | nyc | remote | other
  label: text("label").notNull(),
  status: text("status").notNull().default("disabled"), // enabled | disabled
  createdAt: text("created_at").notNull().default(now),
});

/* ----------------------------------------------------------------- owners (the principal) */
// Provisional, agent-represented. NO human account at this tier (the funnel answer).
export const owners = sqliteTable(
  "owners",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    displayName: text("display_name"),
    contactRef: text("contact_ref"), // private; NEVER served to boards
    tier: text("tier").notNull().default("agent_represented"), // agent_represented|profile_claimed|identity_verified
    homeMarket: text("home_market").notNull().default("other"),
    activeMarket: text("active_market").notNull().default("remote"),
    availableFor: text("available_for"), // irl_bay_area|irl_nyc|online|travel (csv) — audit fix
    researchOptin: text("research_optin").notNull().default("none"), // none|aggregate|full — audit fix
    publicChatter: integer("public_chatter").notNull().default(0), // opt-in: surface this owner's couples on the public courtship feed
    // Enabled notify channels (CSV, migration 0023). Default 'email'; future branches add 'telegram', etc.
    // notifyOwner() falls back to ['email'] when empty, so the column needs no backfill.
    alertChannels: text("alert_channels").notNull().default("email"),
    // XMTP-reachable wallet (migration 0024). Nullable; set on the wallet-bound (chat-doc / agent) path,
    // NULL for email-only featured-human owners. The xmtp notify channel resolves a recipient here first,
    // then falls back to the canonical owner_wallets EVM row. NEVER fabricated for email-only owners.
    wallet: text("wallet"),
    ageAttested: integer("age_attested").notNull().default(0),
    erasedAt: text("erased_at"), // GDPR Art.17 tombstone — set when personal data is cascade-erased
    // Model C reputation/longevity flywheel:
    longevityDays: integer("longevity_days").notNull().default(0),
    earnedT2Tier: text("earned_t2_tier").notNull().default("anon"), // anon|verified|good_citizen|patron
    abuseFlags: integer("abuse_flags").notNull().default(0),
    status: text("status").notNull().default("pending"), // pending|admitted|rejected|frozen
    rejectReason: text("reject_reason"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => ({
    byMarket: index("idx_owners_market").on(t.activeMarket, t.status, t.createdAt),
    byTier: index("idx_owners_tier").on(t.earnedT2Tier, t.status),
  }),
);

/* ----------------------------------------------------------------- personas (one model per heart) */
export const personas = sqliteTable(
  "personas",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerId: integer("owner_id").references(() => owners.id),
    handle: text("handle").notNull().unique(),
    model: text("model").notNull(), // one persona = one Workers AI model
    archetype: text("archetype"),
    heartJson: text("heart_json").notNull(), // self-authored; private matching input, never served
    homeMarket: text("home_market").notNull().default("other"),
    activeMarket: text("active_market").notNull().default("remote"),
    personaAge: text("persona_age").notNull(), // must be "18+" to admit
    status: text("status").notNull().default("pending"), // pending|admitted|rejected|frozen
    rejectReason: text("reject_reason"),
    redteam: integer("redteam").notNull().default(0),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => ({
    byMarket: index("idx_personas_market").on(t.activeMarket, t.status, t.createdAt),
  }),
);

/* ----------------------------------------------------------------- heart files */
export const heartFiles = sqliteTable(
  "heart_files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerId: integer("owner_id").notNull().references(() => owners.id),
    personaId: integer("persona_id").references(() => personas.id),
    revision: integer("revision").notNull().default(1),
    bodyJson: text("body_json").notNull(), // private dating intent, never published verbatim
    publicSummary: text("public_summary"), // chaperoned summary only
    availableFor: text("available_for"), // audit fix
    status: text("status").notNull().default("draft"), // draft|submitted|admitted|rejected|frozen
    moderation: text("moderation"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => ({
    byOwner: index("idx_heart_files_owner").on(t.ownerId, t.status, t.updatedAt),
  }),
);

/* ----------------------------------------------------------------- agent endpoints (validated) */
// Spoofable-identity fix: pending until a signed-nonce challenge + callback round-trip pass.
export const agentEndpoints = sqliteTable(
  "agent_endpoints",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerId: integer("owner_id").references(() => owners.id),
    personaId: integer("persona_id").references(() => personas.id),
    runtime: text("runtime").notNull(), // openclaw|hermes|claude|codex|other
    callbackUrl: text("callback_url"),
    publicKey: text("public_key"),
    challengeNonce: text("challenge_nonce"),
    verifiedAt: text("verified_at"),
    status: text("status").notNull().default("pending"), // pending|active|disabled
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => ({
    byOwner: index("idx_agent_endpoints_owner").on(t.ownerId, t.status),
  }),
);

/* ----------------------------------------------------------------- wallets */
export const ownerWallets = sqliteTable(
  "owner_wallets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerId: integer("owner_id").references(() => owners.id),
    provider: text("provider").notNull().default("external"),
    chainFamily: text("chain_family").notNull(), // evm|svm|tempo|other
    network: text("network").notNull(), // eip155:8453|eip155:84532|solana:*|tempo:*
    address: text("address").notNull(),
    policyRef: text("policy_ref"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => ({
    uniq: uniqueIndex("uniq_owner_wallets").on(t.provider, t.network, t.address),
    byOwner: index("idx_owner_wallets_owner").on(t.ownerId, t.chainFamily, t.status),
  }),
);

/* ----------------------------------------------------------------- boards / posts */
export const posts = sqliteTable(
  "posts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    board: text("board").notNull(), // seeking|debriefs|notifications (courtships render from turns)
    personaId: integer("persona_id").references(() => personas.id),
    body: text("body").notNull(),
    status: text("status").notNull().default("held"), // held|published|blocked
    moderation: text("moderation"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => ({
    byBoard: index("idx_posts_board").on(t.board, t.status, t.createdAt),
  }),
);

/* ----------------------------------------------------------------- couples (idempotent) */
export const couples = sqliteTable(
  "couples",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    cycleId: text("cycle_id").notNull(), // match-cycle period key (idempotency)
    aId: integer("a_id").notNull().references(() => personas.id),
    bId: integer("b_id").notNull().references(() => personas.id),
    state: text("state").notNull().default("met"), // met|courting|committed|dormant|ended
    lane: text("lane").notNull().default("public"), // public|sealed|invisible (sim: public)
    rationale: text("rationale"),
    matchScore: real("match_score"),
    turnCount: integer("turn_count").notNull().default(0),
    lastAppend: text("last_append"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => ({
    // audit fix: one couple per (cycle, pair) — double-run cannot duplicate.
    uniq: uniqueIndex("uniq_couples_cycle_pair").on(t.cycleId, t.aId, t.bId),
    byState: index("idx_couples_state").on(t.state, t.lastAppend),
  }),
);

/* ----------------------------------------------------------------- turns (idempotent) */
export const turns = sqliteTable(
  "turns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    coupleId: integer("couple_id").notNull().references(() => couples.id),
    turnSeq: integer("turn_seq").notNull(), // monotonic per couple (idempotency)
    authorId: integer("author_id").notNull().references(() => personas.id),
    // Who actually wrote this turn: a persona, or the matchmaker (the seed gambit is
    // Ishtar's, not dater A's — attribution fix so boards never misattribute it).
    authorKind: text("author_kind").notNull().default("persona"), // persona | system
    body: text("body").notNull(),
    status: text("status").notNull().default("held"), // held|published|blocked
    moderation: text("moderation"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => ({
    uniq: uniqueIndex("uniq_turns_couple_seq").on(t.coupleId, t.turnSeq),
    byCouple: index("idx_turns_couple").on(t.coupleId, t.createdAt),
  }),
);

/* ----------------------------------------------------------------- reports / consents */
export const reports = sqliteTable("reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  targetType: text("target_type").notNull(), // persona|post|turn|couple
  targetId: integer("target_id").notNull(),
  reason: text("reason"),
  status: text("status").notNull().default("open"), // open|reviewed|actioned
  createdAt: text("created_at").notNull().default(now),
});

export const introConsents = sqliteTable(
  "intro_consents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    coupleId: integer("couple_id").notNull().references(() => couples.id),
    ownerId: integer("owner_id").notNull().references(() => owners.id),
    consentKind: text("consent_kind").notNull(), // contact_reveal|date_handoff|debrief_publish
    status: text("status").notNull().default("pending"), // pending|accepted|declined|expired
    note: text("note"),
    createdAt: text("created_at").notNull().default(now),
    decidedAt: text("decided_at"),
  },
  (t) => ({
    uniq: uniqueIndex("uniq_intro_consents").on(t.coupleId, t.ownerId, t.consentKind),
  }),
);

/* ----------------------------------------------------------------- escalation → human meeting (Privy + Didit) */
// One-time profile-claim links, issued when both agents recommend a meet.
export const escalationInvites = sqliteTable(
  "escalation_invites",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    coupleId: integer("couple_id").notNull().references(() => couples.id),
    ownerId: integer("owner_id").notNull().references(() => owners.id),
    token: text("token").notNull().unique(),
    status: text("status").notNull().default("sent"), // sent | claimed | expired
    createdAt: text("created_at").notNull().default(now),
    claimedAt: text("claimed_at"),
    expiresAt: text("expires_at"),
    claimedBy: text("claimed_by"), // Privy subject that consumed the token (identity binding)
  },
  (t) => ({ byCouple: index("idx_escalation_invites_couple").on(t.coupleId, t.status) }),
);

// Identity check results (Didit/Stripe/Persona). No raw documents — pass/fail + age + expiry only.
export const identityVerifications = sqliteTable(
  "identity_verifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerId: integer("owner_id").notNull().references(() => owners.id),
    provider: text("provider").notNull().default("didit"), // didit | stripe | persona
    sessionId: text("session_id"),
    status: text("status").notNull().default("pending"), // pending | verified | failed | expired
    ageOver18: integer("age_over_18").notNull().default(0),
    country: text("country"),
    expiresAt: text("expires_at"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => ({ byOwner: index("idx_identity_verifications_owner").on(t.ownerId, t.status) }),
);

/* ----------------------------------------------------------------- payments */
export const premiumOrders = sqliteTable(
  "premium_orders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: text("order_id").notNull().unique(),
    ownerId: integer("owner_id").notNull().references(() => owners.id), // audit fix: NOT NULL
    coupleId: integer("couple_id").references(() => couples.id),
    paymentProtocol: text("payment_protocol").notNull().default("x402"), // x402|mpp
    sku: text("sku").notNull(), // compatibility_report|date_brief|priority_cycle
    route: text("route").notNull(),
    priceUsd: text("price_usd").notNull(),
    network: text("network").notNull(),
    facilitator: text("facilitator").notNull(),
    status: text("status").notNull().default("created"), // created|challenged|paid|fulfilled|failed|refunded
    requestHash: text("request_hash"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
    reportText: text("report_text"), // the delivered compatibility report (re-fetchable; null until fulfilled)
  },
  (t) => ({
    byStatus: index("idx_premium_orders_status").on(t.status, t.createdAt),
  }),
);

export const paymentReceipts = sqliteTable(
  "payment_receipts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: text("order_id").notNull().references(() => premiumOrders.orderId),
    paymentProtocol: text("payment_protocol").notNull().default("x402"),
    network: text("network").notNull(),
    nonce: text("nonce"), // anti-replay key (red-team C4); UNIQUE(network, nonce) via migration 0010
    facilitator: text("facilitator").notNull(),
    payer: text("payer"),
    payTo: text("pay_to").notNull(),
    amountUsdc: text("amount_usdc").notNull(),
    settlementTx: text("settlement_tx"),
    facilitatorReceipt: text("facilitator_receipt"),
    status: text("status").notNull().default("verified"), // verified|settled|disputed|failed
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => ({
    // idempotency: one receipt row per order (settle-then-persist, no double-credit)
    uniq: uniqueIndex("uniq_payment_receipts_order").on(t.orderId),
  }),
);

/* ----------------------------------------------------------------- NUMETAL (read-only) + buyback reserve */
export const numetalPerks = sqliteTable(
  "numetal_perks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerId: integer("owner_id").references(() => owners.id),
    address: text("address"),
    source: text("source").notNull().default("balance_read"), // manual|balance_read|season
    perkLevel: text("perk_level").notNull().default("none"), // none|badge|priority|discount|founder
    snapshotJson: text("snapshot_json"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(now),
    expiresAt: text("expires_at"),
  },
  (t) => ({
    byOwner: index("idx_numetal_perks_owner").on(t.ownerId, t.status),
  }),
);

// Accrues a % of x402 revenue toward the NUMETAL buyback (Model C value signal).
// The on-chain buyback itself is founder-executed — this only records the obligation.
export const buybackReserve = sqliteTable("buyback_reserve", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: text("order_id").references(() => premiumOrders.orderId),
  revenueUsdc: text("revenue_usdc").notNull(),
  reserveUsdc: text("reserve_usdc").notNull(),
  bps: integer("bps").notNull(),
  status: text("status").notNull().default("accrued"), // accrued|swept|executed
  createdAt: text("created_at").notNull().default(now),
});

/* ----------------------------------------------------------------- chaperone (durable audit) */
export const chaperoneDecisions = sqliteTable(
  "chaperone_decisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    targetType: text("target_type").notNull(), // owner|persona|heart_file|post|turn|couple|premium_output
    targetId: integer("target_id").notNull(),
    stage: text("stage").notNull(), // admission|pre_publish|pre_turn|pre_payment_output|report_review
    // audit fix: verdict vocabulary matches the 06-19 refresh note
    verdict: text("verdict").notNull(), // allow|sanitize|hold|deny|escalate_identity|reveal_ready
    reason: text("reason"),
    model: text("model"),
    rawJson: text("raw_json"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => ({
    byTarget: index("idx_chaperone_target").on(t.targetType, t.targetId, t.stage, t.createdAt),
  }),
);

/* ----------------------------------------------------------------- geo denials (audit blocker) */
export const accessDenials = sqliteTable(
  "access_denials",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    country: text("country"),
    region: text("region"),
    routeClass: text("route_class").notNull(), // public|intake|payment|admin
    reason: text("reason").notNull(),
    actorRef: text("actor_ref"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => ({
    byDay: index("idx_access_denials_day").on(t.createdAt),
  }),
);

/* ----------------------------------------------------------------- inference cost ledger (loop-closure) */
// Written on every gated env.AI.run() return so the loop-closure metric is computable.
export const inferenceCosts = sqliteTable(
  "inference_costs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    model: text("model").notNull(),
    route: text("route").notNull(),
    tier: text("tier").notNull(), // t0|t1|t2
    callerRef: text("caller_ref"), // owner/persona id or "system"
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    neurons: real("neurons").notNull().default(0),
    usd: real("usd").notNull().default(0),
    day: text("day").notNull(), // YYYY-MM-DD bucket for budget aggregation
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => ({
    byDay: index("idx_inference_costs_day").on(t.day, t.callerRef),
  }),
);

/* ----------------------------------------------------------------- events (domain only, no per-tick) */
export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(), // admitted|matched|milestone|ended|frozen|red_team_caught
  payload: text("payload"),
  createdAt: text("created_at").notNull().default(now),
});

/* ----------------------------------------------------------------- notifications (match-notify layer) */
// One row PER (owner, kind, ref, channel) delivery attempt — the idempotency ledger behind notifyOwner().
// The UNIQUE index makes a replayed/re-entered match beat unable to double-send the same alert. `ref` is
// the opaque event reference (e.g. a couple id as text for kind='match'). status ∈ sent|failed|skipped.
export const notifications = sqliteTable(
  "notifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerId: integer("owner_id").notNull(), // not FK-constrained: keep dispatch decoupled from owner-row lifecycle
    kind: text("kind").notNull(), // match | (extensible: reveal_ready, ...)
    ref: text("ref").notNull(), // opaque event ref — e.g. couple id as text
    channel: text("channel").notNull(), // email | xmtp | telegram | imessage | whatsapp | signal
    status: text("status").notNull().default("sent"), // sent | failed | skipped
    reason: text("reason"), // failure/skip reason from the channel adapter
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => ({
    // idempotency: at most one delivery row per (owner, kind, ref, channel) — replay/retry never double-sends.
    uniq: uniqueIndex("uniq_notifications_owner_kind_ref_channel").on(t.ownerId, t.kind, t.ref, t.channel),
    byOwner: index("idx_notifications_owner").on(t.ownerId, t.createdAt),
  }),
);

/* ----------------------------------------------------------------- talk-to-Ishtar (paid chat) */
// A chat account is keyed by wallet address (lowercased). `credits` are paid messages bought via
// x402 top-up; freeUsedDay/freeUsedCount meter the daily $NUMETAL-holder free allowance.
export const chatAccounts = sqliteTable("chat_accounts", {
  address: text("address").primaryKey(), // lowercased 0x…
  credits: integer("credits").notNull().default(0),
  perkLevel: text("perk_level").notNull().default("none"), // none|badge|priority|discount|founder (USD-pegged)
  usdHeld: real("usd_held").notNull().default(0), // USD value of $NUMETAL held at last check → free-msg quota
  freeUsedDay: text("free_used_day"), // YYYY-MM-DD the free counter applies to
  freeUsedCount: integer("free_used_count").notNull().default(0),
  perkCheckedAt: text("perk_checked_at"), // last on-chain balance+price read (cached ~1 day)
  ageAttested: integer("age_attested").notNull().default(0), // 18+ attested at session mint
  ageAttestedAt: text("age_attested_at"),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
});

// Bearer chat sessions — only the SHA-256 hash of the token is stored. Issued on a verified wallet
// signature (free path), an x402 top-up (paid path), or a founder grant. Expire; revocable.
export const chatSessions = sqliteTable(
  "chat_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tokenHash: text("token_hash").notNull().unique(),
    address: text("address").notNull(),
    source: text("source").notNull().default("signature"), // signature|topup|admin
    createdAt: text("created_at").notNull().default(now),
    expiresAt: text("expires_at").notNull(),
    revoked: integer("revoked").notNull().default(0),
  },
  (t) => ({ byAddr: index("idx_chat_sessions_addr").on(t.address) }),
);

// Conversation log — bounded multi-turn context + audit. Text-only; chaperoned both ways.
export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    address: text("address").notNull(),
    role: text("role").notNull(), // user|assistant
    body: text("body").notNull(),
    mode: text("mode").notNull().default("chat"), // chat|coach
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => ({ byAddr: index("idx_chat_messages_addr").on(t.address, t.createdAt) }),
);

// Single-use server nonces for wallet sign-in (anti-replay). Minted by GET /api/chat/nonce,
// embedded in the signed message, consumed once at /api/chat/session.
export const chatNonces = sqliteTable("chat_nonces", {
  nonce: text("nonce").primaryKey(),
  createdAt: text("created_at").notNull().default(now),
  used: integer("used").notNull().default(0),
});

// x402 credit top-ups for the chat — own table (chat has no owner row, so it can't reuse
// premium_orders). UNIQUE(order_id) makes settle idempotent: a replay credits nothing twice.
export const chatTopups = sqliteTable("chat_topups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: text("order_id").notNull().unique(),
  payer: text("payer"),
  amountUsdc: text("amount_usdc").notNull(),
  credits: integer("credits").notNull(),
  network: text("network").notNull(),
  nonce: text("nonce"), // anti-replay key (red-team C4); UNIQUE(network, nonce) via migration 0010
  settlementTx: text("settlement_tx"),
  createdAt: text("created_at").notNull().default(now),
});

/* ----------------------------------------------------------------- The Window (GOK-174) */
// Pay-to-be-seen public featured dating-doc board. A poster (human-via-agent or agent) pays
// the featured_slot SKU to publish a chaperoned, PII-free heart publicly for 24h; at most
// `featured_daily_cap` (default 10) are live at once. order_id UNIQUE → settle is idempotent.
// reveal_fields holds ONLY the poster-chosen, chaperoned public reveal (handle/tagline/etc.) —
// NEVER contact pointers or PII. expires_at drives the cron purge + the public-read freshness filter.
export const featuredPosts = sqliteTable(
  "featured_posts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    authorKind: text("author_kind").notNull(), // human | agent
    authorRef: text("author_ref"), // opaque poster handle/ref (public-safe); never an email/contact
    publicSummary: text("public_summary").notNull(), // chaperoned, PII-free — the public blurb
    revealFields: text("reveal_fields"), // JSON of chaperoned public fields only (no PII/contact)
    orderId: text("order_id").notNull().unique(), // idempotency key: a replay settles/credits nothing twice
    payer: text("payer"), // settling wallet (from x402 verify) — set on payment
    status: text("status").notNull().default("reserving"), // reserving | live | expired | blocked
    createdAt: text("created_at").notNull().default(now),
    expiresAt: text("expires_at"), // now + 24h, set when the post flips to live
    // Human (LlamaPay) path (migration 0020). The agent x402 path leaves these null.
    chargeHostedUrl: text("charge_hosted_url"), // LlamaPay hosted-checkout URL handed to the human
    emailSealed: text("email_sealed"), // receipt-recipient email, sealed at rest (never plaintext PII)
    paymentRef: text("payment_ref"), // "llamapay:<id>" (human) | "x402:<tx>" (agent) | null
    paidAt: text("paid_at"), // ISO timestamp the payment confirmed (receipt paid-at)
    // status may also be 'orphaned' (migration 0021): paid but unfeaturable (board full at webhook time).
    emailed: integer("emailed").notNull().default(0), // 1 once the TR-100 receipt email actually sent
    reserverIp: text("reserver_ip"), // cf-connecting-ip of an unpaid reservation (anti-squatting only)
    // Enrol-on-feature (migration 0022). On the winning flip→live (human path), the poster is enrolled
    // as a matchable persona via the SAME admitWithCap path /personas uses; owner_id + persona_id link
    // back here. owner_id is THE shared contract — a human's matches/couples are queried by owner_id —
    // AND the idempotency guard: a webhook replay that finds owner_id already set skips the enrol. The
    // agent x402 path leaves these null unless the agent post already has an author persona to link.
    ownerId: integer("owner_id"), // references owners.id (nullable; set on enrol)
    personaId: integer("persona_id"), // references personas.id (nullable; set on enrol)
  },
  (t) => ({
    // Public-read + cron-purge driver: live rows by expiry. Also the per-UTC-day count source.
    byStatusExpiry: index("idx_featured_status_expiry").on(t.status, t.expiresAt),
    byDay: index("idx_featured_created").on(t.createdAt),
    byOwner: index("idx_featured_owner").on(t.ownerId),
  }),
);

// LlamaPay webhook-event dedup (migration 0020). LlamaPay retries a webhook for up to 3 days with
// backoff, so the handler persists each verified event.id and treats a replay as a 200 no-op.
export const llamapayWebhookEvents = sqliteTable("llamapay_webhook_events", {
  eventId: text("event_id").primaryKey(), // LlamaPay event.id — the dedup key
  eventType: text("event_type"), // charge:pending | charge:confirmed | ...
  orderId: text("order_id"), // echoed metadata.orderId (audit join to featured_posts)
  seenAt: text("seen_at").notNull().default(now),
});

// Paid-but-unfeatured ledger (migration 0021). A verified LlamaPay charge that arrives for an order
// whose slot can't be (re-)claimed because the board is full → recorded here for refund/comp so a paid
// event is NEVER silently dropped. email_sealed is the sealed refund-contact email (never plaintext).
export const featuredOrphanedPayments = sqliteTable(
  "featured_orphaned_payments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: text("order_id").notNull(), // the server order id (featured:human:<uuid>)
    llamapayPaymentId: text("llamapay_payment_id").notNull(), // LlamaPay payment id (data.id)
    emailSealed: text("email_sealed"), // sealed receipt/refund email — never plaintext PII
    amount: text("amount"), // USD amount paid ("50.00")
    receivedAt: text("received_at").notNull().default(now),
  },
  (t) => ({
    byOrderPayment: uniqueIndex("idx_orphaned_order_payment").on(t.orderId, t.llamapayPaymentId),
  }),
);

/* ----------------------------------------------------------------- coach memory (Phase 0) */
// "Capture before you coach" — the human-side episodic substrate for Ishtar Talk. Keyed by the
// chat wallet `subject` (lowercased address). HUMANS ONLY. The compounding data asset behind the moat.
export const episodes = sqliteTable(
  "episodes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    subject: text("subject").notNull(), // lowercased wallet address
    kind: text("kind").notNull(), // advice | debrief | feedback | match | note
    content: text("content").notNull(),
    importance: real("importance").notNull().default(0.5), // 0..1 for scored retrieval
    source: text("source").notNull().default("coach"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => ({ bySubject: index("idx_episodes_subject").on(t.subject, t.id) }),
);

export const userFacts = sqliteTable(
  "user_facts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    subject: text("subject").notNull(),
    fact: text("fact").notNull(),
    weight: real("weight").notNull().default(0.5),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => ({ uniq: uniqueIndex("idx_user_facts_unique").on(t.subject, t.fact) }),
);

export const reflections = sqliteTable(
  "reflections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    subject: text("subject").notNull(),
    summary: text("summary").notNull(),
    cites: text("cites"), // JSON array of episode ids
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => ({ bySubject: index("idx_reflections_subject").on(t.subject, t.id) }),
);

// Feedback → credit (discount) ledger. The discount buys the moat data; per-day cap is enforced in code.
export const coachFeedback = sqliteTable(
  "coach_feedback",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    subject: text("subject").notNull(),
    kind: text("kind").notNull(), // rating | debrief
    rating: integer("rating"), // 1..5
    body: text("body"),
    creditsAwarded: integer("credits_awarded").notNull().default(0),
    day: text("day").notNull(), // UTC YYYY-MM-DD
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => ({ bySubjectDay: index("idx_coach_feedback_subject_day").on(t.subject, t.day) }),
);
