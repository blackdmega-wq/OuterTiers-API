import app from "./app.js";
import { logger } from "./lib/logger.js";
import { syncAllPlayers } from "./lib/mojangSync.js";
import { pool } from "./lib/db.js";

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

    setInterval(() => {
      syncAllPlayers().catch(err => logger.error({ err }, "Scheduled Mojang sync failed"));
    }, 24 * 60 * 60 * 1_000);
  });
}).catch(err => {
  logger.error({ err }, "Schema migration failed — exiting");
  process.exit(1);
});
