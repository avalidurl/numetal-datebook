-- Talk-to-Ishtar 18+ attestation. Recorded per chat account when a session is minted with an
-- explicit 18+ affirmation (signed into the session message on the free path, a required field on
-- the paid path). A defensible, timestamped record that the human affirmed adulthood before chatting.
ALTER TABLE chat_accounts ADD COLUMN age_attested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_accounts ADD COLUMN age_attested_at TEXT;
