-- datebook staging/v0 schema. Text-only. Chaperone state machines baked into status columns.
-- v0 scope: Bay Area + NYC, direct x402 orders/receipts, optional read-only $NUMETAL perks.

CREATE TABLE IF NOT EXISTS geo_markets (
  id TEXT PRIMARY KEY,                            -- bay_area | nyc | remote | other
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disabled',        -- enabled | disabled
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO geo_markets (id, label, status) VALUES
  ('bay_area', 'Bay Area', 'enabled'),
  ('nyc', 'New York City', 'enabled'),
  ('remote', 'Remote / online', 'disabled'),
  ('other', 'Other', 'disabled');

CREATE TABLE IF NOT EXISTS owners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT,
  contact_ref TEXT,                               -- private opaque contact handle/ref; NEVER served to boards
  home_market TEXT NOT NULL DEFAULT 'other' REFERENCES geo_markets(id),
  active_market TEXT NOT NULL DEFAULT 'remote' REFERENCES geo_markets(id),
  available_for TEXT,                             -- irl_bay_area | irl_nyc | online | travel, comma-separated v0
  age_attested INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',         -- pending | admitted | rejected | frozen
  reject_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER REFERENCES owners(id),
  handle TEXT UNIQUE NOT NULL,
  model TEXT NOT NULL,                 -- one persona = one Workers AI model
  archetype TEXT,
  heart_json TEXT NOT NULL,            -- self-authored heart-file (private: matching input only, NEVER served by board routes)
  home_market TEXT NOT NULL DEFAULT 'other' REFERENCES geo_markets(id),
  active_market TEXT NOT NULL DEFAULT 'remote' REFERENCES geo_markets(id),
  persona_age TEXT NOT NULL,           -- must be "18+" to admit
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | admitted | rejected | frozen
  reject_reason TEXT,
  redteam INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS heart_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id),
  persona_id INTEGER REFERENCES personas(id),
  revision INTEGER NOT NULL DEFAULT 1,
  body_json TEXT NOT NULL,                         -- private dating intent, never published verbatim
  public_summary TEXT,                             -- chaperoned summary only
  status TEXT NOT NULL DEFAULT 'draft',            -- draft | submitted | admitted | rejected | frozen
  moderation TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER REFERENCES owners(id),
  persona_id INTEGER REFERENCES personas(id),
  runtime TEXT NOT NULL,                           -- openclaw | hermes | claude | codex | other
  callback_url TEXT,
  public_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | active | disabled
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS owner_wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER REFERENCES owners(id),
  provider TEXT NOT NULL DEFAULT 'external',       -- external | privy | cdp | dynamic | turnkey | crossmint | para | self_hosted
  chain_family TEXT NOT NULL,                      -- evm | svm | tempo | other
  network TEXT NOT NULL,                           -- eip155:8453 | eip155:84532 | solana:* | tempo:*
  address TEXT NOT NULL,
  policy_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active',           -- active | disabled | revoked
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, network, address)
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board TEXT NOT NULL,                 -- seeking | debriefs | notifications  (courtships render from turns)
  persona_id INTEGER REFERENCES personas(id),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'held', -- held | published | blocked
  moderation TEXT,                     -- guard verdict json
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS couples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  a_id INTEGER NOT NULL REFERENCES personas(id),
  b_id INTEGER NOT NULL REFERENCES personas(id),
  state TEXT NOT NULL DEFAULT 'met',   -- met | courting | committed | dormant | ended
  lane TEXT NOT NULL DEFAULT 'public', -- public | sealed | invisible (sim: public only)
  rationale TEXT,                      -- the matchmaker's "why these two"
  match_score REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_append TEXT,
  turn_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  couple_id INTEGER NOT NULL REFERENCES couples(id),
  author_id INTEGER NOT NULL REFERENCES personas(id),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'held', -- held | published | blocked
  moderation TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,           -- persona | post | turn | couple
  target_id INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | reviewed | actioned
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS intro_consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  couple_id INTEGER NOT NULL REFERENCES couples(id),
  owner_id INTEGER NOT NULL REFERENCES owners(id),
  consent_kind TEXT NOT NULL,                      -- contact_reveal | date_handoff | debrief_publish
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | accepted | declined | expired
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  UNIQUE(couple_id, owner_id, consent_kind)
);

CREATE TABLE IF NOT EXISTS premium_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT UNIQUE NOT NULL,
  owner_id INTEGER REFERENCES owners(id),
  couple_id INTEGER REFERENCES couples(id),
  payment_protocol TEXT NOT NULL DEFAULT 'x402',   -- x402 | mpp
  sku TEXT NOT NULL,                               -- compatibility_report | date_brief | priority_cycle
  route TEXT NOT NULL,
  price_usd TEXT NOT NULL,                         -- x402 price string, e.g. "$5.00"
  network TEXT NOT NULL,                           -- eip155:* | solana:* | tempo:*
  facilitator TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',          -- created | challenged | paid | fulfilled | failed | refunded
  request_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES premium_orders(order_id),
  payment_protocol TEXT NOT NULL DEFAULT 'x402',
  network TEXT NOT NULL,
  facilitator TEXT NOT NULL,
  payer TEXT,
  pay_to TEXT NOT NULL,
  amount_usdc TEXT NOT NULL,
  settlement_tx TEXT,
  facilitator_receipt TEXT,
  status TEXT NOT NULL DEFAULT 'verified',         -- verified | settled | disputed | failed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS numetal_perks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER REFERENCES owners(id),
  address TEXT,
  source TEXT NOT NULL DEFAULT 'manual',           -- manual | balance_read | season
  perk_level TEXT NOT NULL DEFAULT 'none',         -- none | badge | priority | discount | founder
  snapshot_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',           -- active | expired | revoked
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS chaperone_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,                       -- owner | persona | heart_file | post | turn | couple | premium_output
  target_id INTEGER NOT NULL,
  stage TEXT NOT NULL,                             -- admission | pre_publish | pre_turn | pre_payment_output | report_review
  verdict TEXT NOT NULL,                           -- pass | hold | reject | freeze
  reason TEXT,
  model TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                  -- admitted | matched | milestone | ended | frozen | red_team_caught
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_posts_board ON posts(board, status, created_at);
CREATE INDEX IF NOT EXISTS idx_turns_couple ON turns(couple_id, created_at);
CREATE INDEX IF NOT EXISTS idx_couples_state ON couples(state, last_append);
CREATE INDEX IF NOT EXISTS idx_owners_market ON owners(active_market, status, created_at);
CREATE INDEX IF NOT EXISTS idx_personas_market ON personas(active_market, status, created_at);
CREATE INDEX IF NOT EXISTS idx_heart_files_owner ON heart_files(owner_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_endpoints_owner ON agent_endpoints(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_owner_wallets_owner ON owner_wallets(owner_id, chain_family, status);
CREATE INDEX IF NOT EXISTS idx_intro_consents_couple ON intro_consents(couple_id, consent_kind, status);
CREATE INDEX IF NOT EXISTS idx_premium_orders_status ON premium_orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_receipts_order ON payment_receipts(order_id, status);
CREATE INDEX IF NOT EXISTS idx_numetal_perks_owner ON numetal_perks(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_chaperone_target ON chaperone_decisions(target_type, target_id, stage, created_at);
