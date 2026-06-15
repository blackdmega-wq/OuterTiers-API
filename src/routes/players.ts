import { Router } from "express";
import { db, playersTable, tierResultsTable, type DbPlayer } from "../lib/db.js";
import { eq, desc } from "drizzle-orm";

const router = Router();

function rawTierToLevel(tier: string | null | undefined): string {
  if (!tier) return "-";
  const num = tier.replace(/[^0-9]/g, "");
  return num ? `T${num}` : "-";
}

const TIER_POINTS: Record<string, number> = { T1: 100, T2: 50, T3: 25, T4: 10, T5: 5 };

function calculatePoints(p: DbPlayer): number {
  return [p.ogvanillaTier, p.vanillaTier, p.uhcTier, p.potTier, p.nethopTier,
          p.smpTier, p.swordTier, p.axeTier, p.maceTier, p.speedTier]
    .reduce((sum, t) => sum + (TIER_POINTS[rawTierToLevel(t)] ?? 0), 0);
}

function dbPlayerToWeb(p: DbPlayer) {
  return {
    id: p.userId,
    username: p.username,
    uuid: p.uuid ?? "",
    region: p.region ?? "EU",
    points: calculatePoints(p),
    currentTier: rawTierToLevel(p.currentTier),
    peakTier: rawTierToLevel(p.peakTier),
    tiers: {
      ogvanilla: rawTierToLevel(p.ogvanillaTier),
      vanilla:   rawTierToLevel(p.vanillaTier),
      uhc:       rawTierToLevel(p.uhcTier),
      pot:       rawTierToLevel(p.potTier),
      nethop:    rawTierToLevel(p.nethopTier),
      smp:       rawTierToLevel(p.smpTier),
      sword:     rawTierToLevel(p.swordTier),
      axe:       rawTierToLevel(p.axeTier),
      mace:      rawTierToLevel(p.maceTier),
      speed:     rawTierToLevel(p.speedTier),
    },
    rawTiers: {
      current:   p.currentTier, peak: p.peakTier,
      ogvanilla: p.ogvanillaTier, vanilla: p.vanillaTier,
      uhc:       p.uhcTier,       pot:     p.potTier,
      nethop:    p.nethopTier,    smp:     p.smpTier,
      sword:     p.swordTier,     axe:     p.axeTier,
      mace:      p.maceTier,      speed:   p.speedTier,
    },
  };
}

router.get("/players", async (_req, res) => {
  const rows = await db.select().from(playersTable);
  const players = rows.map(dbPlayerToWeb).sort((a, b) => b.points - a.points);
  return res.json({ players });
});

router.get("/players/:username", async (req, res) => {
  const { username } = req.params;
  const rows = await db.select().from(playersTable);
  const row = rows.find(p => p.username.toLowerCase() === username.toLowerCase());
  if (!row) return res.status(404).json({ error: "Player not found" });

  // Fetch tier results history for this player (newest first)
  const history = await db
    .select({
      mode:      tierResultsTable.mode,
      tier:      tierResultsTable.tier,
      createdAt: tierResultsTable.createdAt,
    })
    .from(tierResultsTable)
    .where(eq(tierResultsTable.userId, row.userId))
    .orderBy(desc(tierResultsTable.createdAt));

  // Current tier per mode from the DB row
  const modeCurrentTier: Record<string, string | null | undefined> = {
    ogvanilla: row.ogvanillaTier, vanilla: row.vanillaTier, uhc: row.uhcTier,
    pot: row.potTier, nethop: row.nethopTier, smp: row.smpTier,
    sword: row.swordTier, axe: row.axeTier, mace: row.maceTier, speed: row.speedTier,
  };

  // Group history by mode (already sorted newest-first)
  const modeHistory: Record<string, Array<{ tier: string; createdAt: number }>> = {};
  for (const r of history) {
    if (!r.mode || !r.tier) continue;
    if (!modeHistory[r.mode]) modeHistory[r.mode] = [];
    modeHistory[r.mode].push({ tier: r.tier, createdAt: r.createdAt });
  }

  // For each mode find when the current-tier streak started (walk back through results)
  // tierDates values are Unix seconds for Discord/display compatibility
  const tierDates: Record<string, number> = {};
  for (const [mode, results] of Object.entries(modeHistory)) {
    const currentTier = modeCurrentTier[mode];
    if (!currentTier) continue;

    // Walk from newest to oldest; keep moving streakStart back while tier matches
    let streakStartMs: number | null = null;
    for (const r of results) {
      if (r.tier === currentTier) {
        streakStartMs = r.createdAt; // earlier match — push start further back
      } else {
        break; // streak broken — stop
      }
    }
    if (streakStartMs != null) {
      tierDates[mode] = Math.floor(streakStartMs / 1000);
    }
  }

  return res.json({ ...dbPlayerToWeb(row), tierDates });
});

export default router;
