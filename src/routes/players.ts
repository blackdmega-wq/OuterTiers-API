import { Router } from "express";
import { db, playersTable, type DbPlayer } from "../lib/db.js";

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
  return res.json(dbPlayerToWeb(row));
});

export default router;
