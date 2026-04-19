import { Router } from "express";
import { db, playersTable, tierResultsTable } from "../lib/db.js";
import { and, eq } from "drizzle-orm";

const router = Router();
const HIGH_TIERS = new Set(["HT3", "LT2", "HT2", "LT1", "HT1"]);

type ModeKey = "sword"|"speed"|"pot"|"nethop"|"ogvanilla"|"vanilla"|"uhc"|"axe"|"mace"|"smp";

function buildModeUpdate(mode: string | undefined, tier: string) {
  if (!mode) return {};
  const updates: Partial<typeof playersTable.$inferInsert> = {};
  switch (mode as ModeKey) {
    case "sword":     updates.swordTier    = tier; break;
    case "speed":     updates.speedTier    = tier; break;
    case "pot":       updates.potTier      = tier; break;
    case "nethop":    updates.nethopTier   = tier; break;
    case "ogvanilla": updates.ogvanillaTier= tier; break;
    case "vanilla":   updates.vanillaTier  = tier; break;
    case "uhc":       updates.uhcTier      = tier; break;
    case "axe":       updates.axeTier      = tier; break;
    case "mace":      updates.maceTier     = tier; break;
    case "smp":       updates.smpTier      = tier; break;
  }
  return updates;
}

router.post("/webhook/tier", async (req, res) => {
  const { secret, type, guildId, userId, username, discordUsername,
          tier, peakTier, mode, region, testerId, testerName, ticketType }
    = req.body as Record<string, string | undefined>;

  if (!secret || secret !== process.env.WEBSITE_API_SECRET)
    return res.status(401).json({ error: "Unauthorized" });
  if (!guildId || !userId)
    return res.status(400).json({ error: "Missing required fields: guildId, userId" });

  const now = Date.now();
  const where = and(eq(playersTable.guildId, guildId), eq(playersTable.userId, userId));

  if (type === "tierwipe") {
    const existing = await db.select({ id: playersTable.id }).from(playersTable).where(where).limit(1);
    if (existing.length > 0) {
      await db.update(playersTable).set({
        currentTier: null, peakTier: null,
        ogvanillaTier: null, vanillaTier: null, uhcTier: null, potTier: null,
        nethopTier: null, smpTier: null, swordTier: null, axeTier: null,
        maceTier: null, speedTier: null, updatedAt: now,
      }).where(where);
    }
    return res.json({ ok: true });
  }

  if (type === "setpeaktier") {
    if (!tier) return res.status(400).json({ error: "Missing tier" });
    const upperTier = tier.toUpperCase();
    const existing = await db.select({ id: playersTable.id }).from(playersTable).where(where).limit(1);
    if (existing.length > 0) {
      await db.update(playersTable).set({ peakTier: upperTier, updatedAt: now }).where(where);
    } else {
      const displayName = username || discordUsername || userId;
      await db.insert(playersTable).values({ guildId, userId, username: displayName, discordUsername, region, peakTier: upperTier, updatedAt: now });
    }
    return res.json({ ok: true });
  }

  if (!tier) return res.status(400).json({ error: "Missing tier" });
  const upperTier = tier.toUpperCase();
  const isHighTier = HIGH_TIERS.has(upperTier);
  const displayName = username || discordUsername || userId;
  const modeUpdate = buildModeUpdate(mode, upperTier);

  const playerBase: typeof playersTable.$inferInsert = {
    guildId, userId, username: displayName, discordUsername, region,
    currentTier: upperTier, updatedAt: now, ...modeUpdate,
  };
  if (peakTier) playerBase.peakTier = peakTier.toUpperCase();

  const existing = await db.select({ id: playersTable.id }).from(playersTable).where(where).limit(1);
  if (existing.length > 0) {
    await db.update(playersTable).set({ ...playerBase }).where(where);
  } else {
    await db.insert(playersTable).values(playerBase);
  }

  await db.insert(tierResultsTable).values({
    guildId, userId, username: displayName, testerId, testerName,
    tier: upperTier, mode: mode ?? null, region, ticketType, isHighTier, createdAt: now,
  });

  return res.json({ ok: true });
});

export default router;
