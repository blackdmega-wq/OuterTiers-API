-- One-time D1 migration. Run this out of band rather than from a Worker request.
-- All statements are safe to rerun; existing identity/name history rows are kept.
CREATE TABLE IF NOT EXISTS player_name_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  uuid TEXT,
  username TEXT NOT NULL,
  observed_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS player_name_history_identity
  ON player_name_history(guild_id, user_id, lower(username));

CREATE INDEX IF NOT EXISTS players_user_id_idx
  ON players(user_id);

CREATE INDEX IF NOT EXISTS player_name_history_user_id_idx
  ON player_name_history(user_id);

INSERT OR IGNORE INTO player_name_history (guild_id, user_id, uuid, username, observed_at)
SELECT guild_id, user_id, uuid, username, updated_at
FROM players
WHERE length(trim(username)) BETWEEN 3 AND 16
  AND trim(username) NOT GLOB '*[^A-Za-z0-9_]*';
