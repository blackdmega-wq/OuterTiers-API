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
  try {
    const rows = await db.select().from(playersTable);
    const players = rows.map(dbPlayerToWeb).sort((a, b) => b.points - a.points);
    return res.json({ players });
  } catch (err) {
    console.error("[/api/players] DB error:", (err as Error).message);
    return res.status(503).json({ error: "Database temporarily unavailable. Please try again." });
  }
});

router.get("/players/:username", async (req, res) => {
  const { username } = req.params;
  try {
    const rows = await db.select().from(playersTable);
    const row = rows.find(p => p.username.toLowerCase() === username.toLowerCase());
    if (!row) return res.status(404).json({ error: "Player not found" });

    const history = await db
      .select({
        mode:      tierResultsTable.mode,
        tier:      tierResultsTable.tier,
        createdAt: tierResultsTable.createdAt,
      })
      .from(tierResultsTable)
      .where(eq(tierResultsTable.userId, row.userId))
      .orderBy(desc(tierResultsTable.createdAt));

    const modeCurrentTier: Record<string, string | null | undefined> = {
      ogvanilla: row.ogvanillaTier, vanilla: row.vanillaTier, uhc: row.uhcTier,
      pot: row.potTier, nethop: row.nethopTier, smp: row.smpTier,
      sword: row.swordTier, axe: row.axeTier, mace: row.maceTier, speed: row.speedTier,
    };

    const modeHistory: Record<string, Array<{ tier: string; createdAt: number }>> = {};
    for (const r of history) {
      if (!r.mode || !r.tier) continue;
      if (!modeHistory[r.mode]) modeHistory[r.mode] = [];
      modeHistory[r.mode].push({ tier: r.tier, createdAt: r.createdAt });
    }

    const tierDates: Record<string, number> = {};
    for (const [mode, results] of Object.entries(modeHistory)) {
      const currentTier = modeCurrentTier[mode];
      if (!currentTier) continue;
      let streakStartMs: number | null = null;
      for (const r of results) {
        if (r.tier === currentTier) {
          streakStartMs = r.createdAt;
        } else {
          break;
        }
      }
      if (streakStartMs != null) {
        tierDates[mode] = Math.floor(streakStartMs / 1000);
      }
    }

    return res.json({ ...dbPlayerToWeb(row), tierDates });
  } catch (err) {
    console.error("[/api/players/:username] DB error:", (err as Error).message);
    return res.status(503).json({ error: "Database temporarily unavailable. Please try again." });
  }
});

export default router;
