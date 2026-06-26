import { Router } from "express";
import { db, playersTable } from "../lib/db.js";

const router = Router();

interface MigratePlayer {
  guildId: string;
  userId: string;
  username: string;
  currentTier?: string | null;
  peakTier?: string | null;
  region?: string | null;
  swordTier?: string | null;
  speedTier?: string | null;
  potTier?: string | null;
  nethopTier?: string | null;
  ogvanillaTier?: string | null;
  vanillaTier?: string | null;
  uhcTier?: string | null;
  axeTier?: string | null;
  maceTier?: string | null;
  smpTier?: string | null;
}

router.post("/migrate", async (req, res) => {
  const { secret, players } = req.body as { secret?: string; players?: MigratePlayer[] };

  if (!secret || secret !== process.env.WEBSITE_API_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  if (!Array.isArray(players) || players.length === 0)
    return res.status(400).json({ error: "players must be a non-empty array" });

  try {
    const now = Date.now();
    let inserted = 0;

    for (const p of players) {
      if (!p.guildId || !p.userId || !p.username) continue;

      const record = {
        guildId: p.guildId,
        userId: p.userId,
        username: p.username,
        currentTier: p.currentTier || null,
        peakTier: p.peakTier || null,
        region: p.region || null,
        swordTier: p.swordTier || null,
        speedTier: p.speedTier || null,
        potTier: p.potTier || null,
        nethopTier: p.nethopTier || null,
        ogvanillaTier: p.ogvanillaTier || null,
        vanillaTier: p.vanillaTier || null,
        uhcTier: p.uhcTier || null,
        axeTier: p.axeTier || null,
        maceTier: p.maceTier || null,
        smpTier: p.smpTier || null,
        updatedAt: now,
      };

      await db.insert(playersTable)
        .values(record)
        .onConflictDoUpdate({
          target: [playersTable.guildId, playersTable.userId],
          set: record,
        });

      inserted++;
    }

    console.log(`[/api/migrate] Migrated ${inserted} players`);
    return res.json({ ok: true, inserted });
  } catch (err) {
    console.error("[/api/migrate] DB error:", (err as Error).message);
    return res.status(503).json({ error: "Database temporarily unavailable. Please try again." });
  }
});

export default router;
