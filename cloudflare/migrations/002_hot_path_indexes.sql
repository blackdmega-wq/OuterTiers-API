-- Bound common lookups and presence cleanup to matching index ranges.
-- CREATE INDEX IF NOT EXISTS makes this safe to rerun.
CREATE TABLE IF NOT EXISTS presence (
  client_id TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS presence_last_seen_idx ON presence(last_seen);
CREATE INDEX IF NOT EXISTS players_username_lower_updated_idx ON players(lower(username), updated_at DESC);
CREATE INDEX IF NOT EXISTS players_uuid_normalized_idx ON players(lower(replace(uuid, '-', '')));
CREATE INDEX IF NOT EXISTS tier_results_username_lower_created_idx ON tier_results(lower(username), created_at DESC);
CREATE INDEX IF NOT EXISTS punishments_username_lower_created_idx ON punishments(lower(username), created_at DESC);
CREATE INDEX IF NOT EXISTS player_name_history_username_lower_observed_idx ON player_name_history(lower(username), observed_at DESC, id DESC);
