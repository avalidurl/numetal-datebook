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
    ageAttested: integer("age_attested").notNull().default(0),
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
