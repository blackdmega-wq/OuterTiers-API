import app from "./app.js";
import { logger } from "./lib/logger.js";
import { syncAllPlayers } from "./lib/mojangSync.js";
import { pool } from "./lib/db.js";
import { backfillHighTier } from "./lib/backfillHighTier.js";

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      discord_username TEXT,
      uuid TEXT,
      region TEXT,
      current_tier TEXT,
      peak_tier TEXT,
      ogvanilla_tier TEXT,
      vanilla_tier TEXT,
      uhc_tier TEXT,
      pot_tier TEXT,
      nethop_tier TEXT,
      smp_tier TEXT,
      sword_tier TEXT,
      axe_tier TEXT,
      mace_tier TEXT,
      speed_tier TEXT,
      updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now())*1000)::BIGINT,
      CONSTRAINT players_guild_user UNIQUE (guild_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tier_results (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      tester_id TEXT,
      tester_name TEXT,
      tier TEXT NOT NULL,
      mode TEXT,
      region TEXT,
      ticket_type TEXT,
      is_high_tier BOOLEAN NOT NULL DEFAULT false,
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now())*1000)::BIGINT
    )
  `);
  // CREATE TABLE IF NOT EXISTS does not add columns to databases created by
  // the legacy website server. Keep the live API schema additive and idempotent.
  await pool.query(`
    ALTER TABLE tier_results
      ADD COLUMN IF NOT EXISTS mode TEXT,
      ADD COLUMN IF NOT EXISTS region TEXT,
      ADD COLUMN IF NOT EXISTS ticket_type TEXT,
      ADD COLUMN IF NOT EXISTS is_high_tier BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now())*1000)::BIGINT
  `);
  await pool.query(`
    ALTER TABLE players
      ADD COLUMN IF NOT EXISTS discord_username TEXT,
      ADD COLUMN IF NOT EXISTS uuid TEXT,
      ADD COLUMN IF NOT EXISTS region TEXT,
      ADD COLUMN IF NOT EXISTS current_tier TEXT,
      ADD COLUMN IF NOT EXISTS peak_tier TEXT,
      ADD COLUMN IF NOT EXISTS ogvanilla_tier TEXT,
      ADD COLUMN IF NOT EXISTS vanilla_tier TEXT,
      ADD COLUMN IF NOT EXISTS uhc_tier TEXT,
      ADD COLUMN IF NOT EXISTS pot_tier TEXT,
      ADD COLUMN IF NOT EXISTS nethop_tier TEXT,
      ADD COLUMN IF NOT EXISTS smp_tier TEXT,
      ADD COLUMN IF NOT EXISTS sword_tier TEXT,
      ADD COLUMN IF NOT EXISTS axe_tier TEXT,
      ADD COLUMN IF NOT EXISTS mace_tier TEXT,
      ADD COLUMN IF NOT EXISTS speed_tier TEXT
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS punishments (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      type TEXT NOT NULL,
      reason TEXT,
      duration_ms BIGINT,
      expires_at BIGINT,
      active BOOLEAN NOT NULL DEFAULT true,
      pardoned_by TEXT,
      pardoned_at BIGINT,
      moderator_id TEXT,
      moderator_name TEXT,
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now())*1000)::BIGINT
    )
  `);
  logger.info("DB schema ready");
}

const rawPort = process.env["PORT"] ?? "3000";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

ensureSchema().then(() => {
  app.listen(port, () => {
    logger.info({ port }, "Server listening");

    setTimeout(() => {
      syncAllPlayers().catch(err => logger.error({ err }, "Startup Mojang sync failed"));
    }, 5_000);

    backfillHighTier().catch(err => logger.error({ err }, "Startup high-tier backfill failed"));

    setInterval(() => {
      syncAllPlayers().catch(err => logger.error({ err }, "Scheduled Mojang sync failed"));
    }, 24 * 60 * 60 * 1_000);
  });
}).catch(err => {
  logger.error({ err }, "Schema migration failed — exiting");
  process.exit(1);
});
