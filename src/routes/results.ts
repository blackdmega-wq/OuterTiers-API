import { Router } from "express";
import { db, playersTable, tierResultsTable } from "../lib/db.js";
import { desc, eq, inArray } from "drizzle-orm";

const router = Router();
const MC_NAME_RE = /^[a-zA-Z0-9_]{3,16}$/;

async function attachPlayerUuids<T extends { guildId: string; userId: string }>(rows: T[]) {
  const userIds = [...new Set(rows.map(row => row.userId))];
  if (userIds.length === 0) return rows.map(row => ({ ...row, uuid: null as string | null }));

  const players = await db.select({
    guildId: playersTable.guildId,
    userId: playersTable.userId,
    uuid: playersTable.uuid,
  }).from(playersTable).where(inArray(playersTable.userId, userIds));
  const byPlayer = new Map(players.map(player => [`${player.guildId}:${player.userId}`, player.uuid]));

  return rows.map(row => ({
    ...row,
    uuid: byPlayer.get(`${row.guildId}:${row.userId}`) ?? null,
  }));
}

router.get("/results/live", async (_req, res) => {
  const rows = (await db.select().from(tierResultsTable)
    .orderBy(desc(tierResultsTable.createdAt)))
    .filter(row => MC_NAME_RE.test(String(row.username ?? "").trim()))
    .slice(0, 30);
  const results = await attachPlayerUuids(rows);
  res.setHeader("Cache-Control", "no-store");
  return res.json({ results });
});

router.get("/results/high-tier", async (_req, res) => {
  const rows = (await db.select().from(tierResultsTable)
    .where(eq(tierResultsTable.isHighTier, true))
    .orderBy(desc(tierResultsTable.createdAt)))
    .filter(row => MC_NAME_RE.test(String(row.username ?? "").trim()))
    .slice(0, 30);
  const results = await attachPlayerUuids(rows);
  res.setHeader("Cache-Control", "no-store");
  return res.json({ results });
});

export default router;
