import { Router } from "express";
import { db, playersTable } from "../lib/db.js";

const router = Router();
const MC_NAME_RE = /^[a-zA-Z0-9_]{3,16}$/;
const MC_UUID_RE = /^[0-9a-f]{32}$/i;

function normalizeUuid(value: unknown): string | null {
  const compact = String(value ?? "").replace(/-/g, "").trim().toLowerCase();
  return MC_UUID_RE.test(compact) ? compact : null;
}

interface MigratePlayer {
  guildId: string;
  userId: string;
  username: string;
  uuid?: string | null;
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
  spearMaceTier?: string | null;
  minecartTier?: string | null;
  diamondSmpTier?: string | null;
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
    let skipped = 0;

    for (const p of players) {
      const username = String(p.username ?? "").trim();
      const uuid = normalizeUuid(p.uuid);
      // This endpoint is a public-data boundary. A Discord nickname, a
      // ticket note, or a generated internal UUID must never enter the
      // website database as a Minecraft identity.
      if (!p.guildId || !p.userId || !MC_NAME_RE.test(username) || !uuid) {
        skipped++;
        continue;
      }

      const record = {
        guildId: p.guildId,
        userId: p.userId,
        username,
        uuid,
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
        spearMaceTier: p.spearMaceTier || null,
        minecartTier: p.minecartTier || null,
        diamondSmpTier: p.diamondSmpTier || null,
        updatedAt: now,
      };

      // A snapshot may contain only the modes known to the bot. Do not erase
      // existing website tiers when an omitted mode arrives as null.
      const update: Partial<typeof record> = { ...record };
      for (const key of Object.keys(update) as Array<keyof typeof record>) {
        if (key !== "updatedAt" && update[key] == null) delete update[key];
      }
      await db.insert(playersTable)
        .values(record)
        .onConflictDoUpdate({
          target: [playersTable.guildId, playersTable.userId],
          set: update,
        });

      inserted++;
    }

    console.log(`[/api/migrate] Migrated ${inserted} players, skipped ${skipped} unverified identities`);
    return res.json({ ok: true, inserted, skipped });
  } catch (err) {
    console.error("[/api/migrate] DB error:", (err as Error).message);
    return res.status(503).json({ error: "Database temporarily unavailable. Please try again." });
  }
});

export default router;
