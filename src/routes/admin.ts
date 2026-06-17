import { Router } from "express";
import { syncAllPlayers } from "../lib/mojangSync.js";
import { db, playersTable } from "../lib/db.js";
import { and, eq } from "drizzle-orm";

const router = Router();

function requireSecret(req: any, res: any): boolean {
  const secret = (req.headers["x-admin-secret"] as string) || req.body?.secret;
  if (!secret || secret !== process.env.WEBSITE_API_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

/** Trigger a full Mojang UUID + rename sync. */
router.post("/admin/sync", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const result = await syncAllPlayers();
  return res.json({ ok: true, ...result });
});

/**
 * Manually update a player's username (for cracked / offline-mode players
 * whose name doesn't exist on Mojang and cannot be auto-discovered).
 * Body: { secret, guildId, userId, newUsername }
 */
router.post("/admin/fix-username", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const { guildId, userId, newUsername } = req.body as Record<string, string | undefined>;
  if (!guildId || !userId || !newUsername) {
    return res.status(400).json({ error: "Missing guildId, userId, or newUsername" });
  }
  const where = and(eq(playersTable.guildId, guildId), eq(playersTable.userId, userId));
  const existing = await db.select({ id: playersTable.id }).from(playersTable).where(where).limit(1);
  if (!existing.length) return res.status(404).json({ error: "Player not found" });
  await db.update(playersTable).set({ username: newUsername, updatedAt: Date.now() }).where(where);
  return res.json({ ok: true, newUsername });
});

export default router;
