import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { pgTable, serial, text, bigint, boolean, unique } from "drizzle-orm/pg-core";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set.");
}

export const playersTable = pgTable(
  "players",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    username: text("username").notNull(),
    discordUsername: text("discord_username"),
    uuid: text("uuid"),
    region: text("region"),
    currentTier: text("current_tier"),
    peakTier: text("peak_tier"),
    ogvanillaTier: text("ogvanilla_tier"),
    vanillaTier: text("vanilla_tier"),
    uhcTier: text("uhc_tier"),
    potTier: text("pot_tier"),
    nethopTier: text("nethop_tier"),
    smpTier: text("smp_tier"),
    swordTier: text("sword_tier"),
    axeTier: text("axe_tier"),
    maceTier: text("mace_tier"),
    speedTier: text("speed_tier"),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().$defaultFn(() => Date.now()),
  },
  (t) => [unique("players_guild_user").on(t.guildId, t.userId)]
);

export const tierResultsTable = pgTable("tier_results", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  username: text("username").notNull(),
  testerId: text("tester_id"),
  testerName: text("tester_name"),
  tier: text("tier").notNull(),
  mode: text("mode"),
  region: text("region"),
  ticketType: text("ticket_type"),
  isHighTier: boolean("is_high_tier").notNull().default(false),
  createdAt: bigint("created_at", { mode: "number" }).notNull().$defaultFn(() => Date.now()),
});

export type DbPlayer = typeof playersTable.$inferSelect;
export type DbTierResult = typeof tierResultsTable.$inferSelect;

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema: { playersTable, tierResultsTable } });
