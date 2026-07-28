import { Router } from "express";
import { syncAllPlayers } from "../lib/mojangSync.js";
import { db, playersTable, tierResultsTable, punishmentsTable } from "../lib/db.js";
import { and, eq, desc, sql, ilike, or, inArray } from "drizzle-orm";

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

/**
 * Fix a player's username by matching on their current (wrong) stored username.
 * Useful when a Discord display name was accidentally saved instead of the MC IGN.
 * Body: { secret, oldUsername, newUsername }
 */
router.post("/admin/fix-username-by-display", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const { oldUsername, newUsername } = req.body as Record<string, string | undefined>;
  if (!oldUsername || !newUsername) {
    return res.status(400).json({ error: "Missing oldUsername or newUsername" });
  }
  const rows = await db
    .select({ id: playersTable.id, userId: playersTable.userId })
    .from(playersTable)
    .where(ilike(playersTable.username, oldUsername))
    .limit(10);
  if (!rows.length) return res.status(404).json({ error: "No player found with that username" });
  await db.update(playersTable)
    .set({ username: newUsername, updatedAt: Date.now() })
    .where(ilike(playersTable.username, oldUsername));
  return res.json({ ok: true, fixed: rows.length, newUsername });
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
    // Also match by userId in case the player's username changed since some
    // results were recorded (results/punishments are keyed by userId).
    const playerRows = await db.select({ userId: playersTable.userId })
      .from(playersTable)
      .where(ilike(playersTable.username, username));
    const userIds = playerRows.map(p => p.userId);

    const resultsWhere = userIds.length
      ? or(ilike(tierResultsTable.username, username), inArray(tierResultsTable.userId, userIds))
      : ilike(tierResultsTable.username, username);
    const punishmentsWhere = userIds.length
      ? or(ilike(punishmentsTable.username, username), inArray(punishmentsTable.userId, userIds))
      : ilike(punishmentsTable.username, username);

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
    console.error("[/api/admin/players/:username/history] DB error:", (err as Error).message, (err as Error).stack);
    return res.status(500).json({ error: "Failed to delete player history.", detail: (err as Error).message });
  }
});

// ── Duplicate player inspection + cleanup ────────────────────────────────────

/**
 * GET /api/admin/players/duplicates
 * Returns all username groups that appear more than once in the players table.
 * Use this to identify ghost rows (same IGN, different Discord userId).
 */
router.get("/admin/players/duplicates", async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const rows = await db.select().from(playersTable);
    const byUsername = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = row.username.toLowerCase();
      if (!byUsername.has(key)) byUsername.set(key, []);
      byUsername.get(key)!.push(row);
    }
    const duplicates: Record<string, object[]> = {};
    for (const [name, group] of byUsername) {
      if (group.length > 1) {
        duplicates[name] = group.map(r => ({
          id: r.id,
          userId: r.userId,
          username: r.username,
          updatedAt: r.updatedAt,
          currentTier: r.currentTier,
          tierCount: [r.ogvanillaTier, r.vanillaTier, r.uhcTier, r.potTier,
                      r.nethopTier, r.smpTier, r.swordTier, r.axeTier,
                      r.maceTier, r.speedTier].filter(Boolean).length,
        }));
      }
    }
    return res.json({ duplicateCount: Object.keys(duplicates).length, duplicates });
  } catch (err) {
    console.error("[/api/admin/players/duplicates] DB error:", (err as Error).message);
    return res.status(503).json({ error: "Database temporarily unavailable." });
  }
});

/**
 * DELETE /api/admin/players/by-userid
 * Body: { secret, guildId, userId }
 * Deletes a specific player row by (guildId, userId). Use to remove ghost/stale
 * duplicate rows identified via GET /api/admin/players/duplicates.
 * Does NOT delete tier_results or punishments (those stay for history).
 */
router.delete("/admin/players/by-userid", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const { guildId, userId } = req.body as Record<string, string | undefined>;
  if (!guildId || !userId) return res.status(400).json({ error: "Missing guildId or userId" });
  try {
    const where = and(eq(playersTable.guildId, guildId), eq(playersTable.userId, userId));
    const existing = await db.select({ id: playersTable.id, username: playersTable.username })
      .from(playersTable).where(where).limit(1);
    if (!existing.length) return res.status(404).json({ error: "Player row not found" });
    await db.delete(playersTable).where(where);
    console.log(`[admin] Deleted player row: guildId=${guildId} userId=${userId} username=${existing[0].username}`);
    return res.json({ ok: true, deleted: { userId, username: existing[0].username } });
  } catch (err) {
    console.error("[/api/admin/players/by-userid] DB error:", (err as Error).message);
    return res.status(503).json({ error: "Database temporarily unavailable." });
  }
});

/**
 * POST /api/admin/players/deduplicate
 * Body: { secret }
 * Auto-deduplicates ALL duplicate username groups in one call.
 * For each group, keeps the row with the most tier data (highest tier column count),
 * falling back to the most recently updated. Deletes the rest.
 * Returns a summary of what was removed.
 */
router.post("/admin/players/deduplicate", async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const rows = await db.select().from(playersTable);
    const byUsername = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = row.username.toLowerCase();
      if (!byUsername.has(key)) byUsername.set(key, []);
      byUsername.get(key)!.push(row);
    }

    const tierCount = (r: typeof rows[number]) =>
      [r.ogvanillaTier, r.vanillaTier, r.uhcTier, r.potTier,
       r.nethopTier, r.smpTier, r.swordTier, r.axeTier,
       r.maceTier, r.speedTier, r.currentTier].filter(Boolean).length;

    const deleted: object[] = [];
    for (const [, group] of byUsername) {
      if (group.length <= 1) continue;
      // Sort: most tiers first, most recent as tiebreaker
      group.sort((a, b) =>
        tierCount(b) - tierCount(a) || b.updatedAt - a.updatedAt
      );
      const [keep, ...remove] = group;
      for (const row of remove) {
        await db.delete(playersTable)
          .where(and(eq(playersTable.guildId, row.guildId), eq(playersTable.userId, row.userId)));
        deleted.push({ userId: row.userId, username: row.username, keptUserId: keep.userId });
        console.log(`[admin/deduplicate] Removed ghost row userId=${row.userId} username=${row.username}, kept userId=${keep.userId}`);
      }
    }
    return res.json({ ok: true, removedCount: deleted.length, removed: deleted });
  } catch (err) {
    console.error("[/api/admin/players/deduplicate] DB error:", (err as Error).message);
    return res.status(503).json({ error: "Database temporarily unavailable." });
  }
});

export default router;
