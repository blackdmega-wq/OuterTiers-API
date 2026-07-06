import { Router } from "express";
import { syncAllPlayers } from "../lib/mojangSync.js";
import { db, playersTable, tierResultsTable, punishmentsTable } from "../lib/db.js";
import { and, eq, desc, sql, ilike } from "drizzle-orm";

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

// ── Admin history GUI: list all test results (paginated, optional search) ────
// GET /api/admin/results?search=<username>&limit=50&offset=0
router.get("/admin/results", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const search = (req.query.search as string | undefined)?.trim();
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  try {
    const where = search ? ilike(tierResultsTable.username, `%${search}%`) : undefined;
    const rows = await db.select().from(tierResultsTable)
      .where(where)
      .orderBy(desc(tierResultsTable.createdAt))
      .limit(limit).offset(offset);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(tierResultsTable).where(where);
    return res.json({ results: rows, total: count });
  } catch (err) {
    console.error("[/api/admin/results] DB error:", (err as Error).message);
    return res.status(503).json({ error: "Database temporarily unavailable. Please try again." });
  }
});

// GET /api/admin/punishments?search=<username>&limit=50&offset=0
router.get("/admin/punishments", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const search = (req.query.search as string | undefined)?.trim();
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  try {
    const where = search ? ilike(punishmentsTable.username, `%${search}%`) : undefined;
    const rows = await db.select().from(punishmentsTable)
      .where(where)
      .orderBy(desc(punishmentsTable.createdAt))
      .limit(limit).offset(offset);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(punishmentsTable).where(where);
    return res.json({ results: rows, total: count });
  } catch (err) {
    console.error("[/api/admin/punishments] DB error:", (err as Error).message);
    return res.status(503).json({ error: "Database temporarily unavailable. Please try again." });
  }
});

// DELETE /api/admin/results/:id — delete a single tier result row
router.delete("/admin/results/:id", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    const result = await db.delete(tierResultsTable).where(eq(tierResultsTable.id, id));
    const count = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    if (count === 0) return res.status(404).json({ error: "Result not found" });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[/api/admin/results/:id] DB error:", (err as Error).message);
    return res.status(503).json({ error: "Database temporarily unavailable. Please try again." });
  }
});

// DELETE /api/admin/punishments/:id — delete a single punishment row
router.delete("/admin/punishments/:id", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    const result = await db.delete(punishmentsTable).where(eq(punishmentsTable.id, id));
    const count = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    if (count === 0) return res.status(404).json({ error: "Punishment not found" });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[/api/admin/punishments/:id] DB error:", (err as Error).message);
    return res.status(503).json({ error: "Database temporarily unavailable. Please try again." });
  }
});

// DELETE /api/admin/players/:username/history — wipe ALL test results +
// punishments for a player (matched case-insensitively by username). This is
// what both the Discord /deletetesthistory command and the website admin
// panel call. It removes the player from the "High Tier" feed, the "All
// Results" feed, and their profile's test-result/punishment lists — those
// pages all read directly from tier_results / punishments, so deleting the
// rows here is sufficient; no separate "feed" tables exist.
router.delete("/admin/players/:username/history", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const { username } = req.params;
  if (!username) return res.status(400).json({ error: "Missing username" });
  try {
    const usernameMatch = sql`lower(${tierResultsTable.username}) = ${username.toLowerCase()}`;
    const punishmentMatch = sql`lower(${punishmentsTable.username}) = ${username.toLowerCase()}`;

    // Also match by userId in case the player's username changed since some
    // results were recorded (results/punishments are keyed by userId).
    const playerRows = await db.select({ userId: playersTable.userId })
      .from(playersTable)
      .where(sql`lower(${playersTable.username}) = ${username.toLowerCase()}`);
    const userIds = playerRows.map(p => p.userId);

    const resultsWhere = userIds.length
      ? sql`(${usernameMatch}) OR ${tierResultsTable.userId} = ANY(${userIds})`
      : usernameMatch;
    const punishmentsWhere = userIds.length
      ? sql`(${punishmentMatch}) OR ${punishmentsTable.userId} = ANY(${userIds})`
      : punishmentMatch;

    const [resultsDeleted, punishmentsDeleted] = await Promise.all([
      db.delete(tierResultsTable).where(resultsWhere),
      db.delete(punishmentsTable).where(punishmentsWhere),
    ]);

    const resultsCount = (resultsDeleted as unknown as { rowCount?: number }).rowCount ?? 0;
    const punishmentsCount = (punishmentsDeleted as unknown as { rowCount?: number }).rowCount ?? 0;

    if (resultsCount === 0 && punishmentsCount === 0 && userIds.length === 0) {
      return res.status(404).json({ error: "Player not found and no history matched" });
    }

    return res.json({ ok: true, resultsDeleted: resultsCount, punishmentsDeleted: punishmentsCount });
  } catch (err) {
    console.error("[/api/admin/players/:username/history] DB error:", (err as Error).message);
    return res.status(503).json({ error: "Database temporarily unavailable. Please try again." });
  }
});

export default router;
