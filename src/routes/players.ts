import { Router } from "express";
import { db, playersTable, tierResultsTable, punishmentsTable, type DbPlayer } from "../lib/db.js";
import { eq, desc, sql } from "drizzle-orm";

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

/** Count non-null tier columns — used to prefer the "richer" row when deduplicating. */
function tierScore(p: DbPlayer): number {
  return [p.ogvanillaTier, p.vanillaTier, p.uhcTier, p.potTier, p.nethopTier,
          p.smpTier, p.swordTier, p.axeTier, p.maceTier, p.speedTier, p.currentTier]
    .filter(Boolean).length;
}

/**
 * Deduplicate a set of player rows by username (case-insensitive).
 * When multiple rows share a username, keep the one with the most tier data
 * (highest tierScore), falling back to the most recently updated row.
 * This handles the ghost-row problem where an old userId ends up with the
 * same IGN as the current account but no tier data.
 */
function deduplicateByUsername(rows: DbPlayer[]): DbPlayer[] {
  const best = new Map<string, DbPlayer>();
  for (const row of rows) {
    const key = row.username.toLowerCase();
    const existing = best.get(key);
    if (!existing) { best.set(key, row); continue; }
    const existingScore = tierScore(existing);
    const rowScore = tierScore(row);
    if (rowScore > existingScore || (rowScore === existingScore && row.updatedAt > existing.updatedAt)) {
      best.set(key, row);
    }
  }
  return [...best.values()];
}

router.get("/players", async (_req, res) => {
  try {
    const rows = await db.select().from(playersTable);
    // Deduplicate: if the same IGN appears under two different Discord IDs (ghost
    // rows from old accounts or backfills), expose only the richest row so the
    // player list never shows the same name twice.
    const deduped = deduplicateByUsername(rows);
    const players = deduped.map(dbPlayerToWeb).sort((a, b) => b.points - a.points);
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
    // Find all rows matching this username, then pick the richest one (most tier data).
    // This prevents a stale ghost row (old Discord ID, no tiers) from shadowing the
    // real row when Array.find() would otherwise return whichever came first in the DB.
    let matches = rows.filter(p => p.username.toLowerCase() === username.toLowerCase());

    // UUID fallback: if no username match and the identifier looks like a UUID
    // (32 hex chars, no dashes), try matching by the uuid column.
    // This lets the TierTagger mod look up players by Minecraft UUID even if their
    // in-game name doesn't match the stored username (e.g. after a name change).
    if (matches.length === 0) {
      const normalized = username.replace(/-/g, "").toLowerCase();
      if (/^[0-9a-f]{32}$/.test(normalized)) {
        matches = rows.filter(
          p => p.uuid && p.uuid.replace(/-/g, "").toLowerCase() === normalized
        );
      }
    }

    const row = matches.length > 1
      ? matches.reduce((best, cur) =>
          tierScore(cur) > tierScore(best) ||
          (tierScore(cur) === tierScore(best) && cur.updatedAt > best.updatedAt)
            ? cur : best)
      : matches[0];
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

    // Compute per-mode peak tier from full test history
    const PEAK_TIER_ORDER = ['HT1','LT1','HT2','LT2','HT3','LT3','HT4','LT4','HT5','LT5'];
    const peakTiers: Record<string, string> = {};
    for (const [mode, results] of Object.entries(modeHistory)) {
      let best: string | null = null;
      for (const r of results) {
        if (!r.tier) continue;
        const ut = r.tier.toUpperCase();
        const rank = PEAK_TIER_ORDER.indexOf(ut);
        if (rank === -1) continue;
        if (best === null || rank < PEAK_TIER_ORDER.indexOf(best)) best = ut;
      }
      if (best) {
        // Normalise 'crystal'→'vanilla' to match frontend category ids (CATEGORIES uses 'vanilla' for Crystal)
        const normMode = mode === 'crystal' ? 'vanilla' : mode;
        if (!peakTiers[normMode] || PEAK_TIER_ORDER.indexOf(best) < PEAK_TIER_ORDER.indexOf(peakTiers[normMode])) {
          peakTiers[normMode] = best;
        }
      }
    }

    return res.json({ ...dbPlayerToWeb(row), tierDates, peakTiers });
  } catch (err) {
    console.error("[/api/players/:username] DB error:", (err as Error).message);
    return res.status(503).json({ error: "Database temporarily unavailable. Please try again." });
  }
});

// ── Player history endpoint ──────────────────────────────────────────────────
// Returns all test results and punishments for a given player.
// Called by the PlayerProfile page on the OuterTiers website.

router.get("/players/:username/history", async (req, res) => {
  const { username } = req.params;
  try {
    // First try to find the player in the players table (for userId-based lookup)
    const playerRows = await db.select().from(playersTable);
    const player = playerRows.find(p => p.username.toLowerCase() === username.toLowerCase());

    // Query tier_results and punishments by userId if player exists, otherwise by username directly.
    // This ensures results are returned even if the player isn't in the players table yet
    // (e.g. history was backfilled via /synctesthistory before the player was registered).
    const [testResults, punishments] = await Promise.all([
      player
        ? db.select().from(tierResultsTable)
            .where(eq(tierResultsTable.userId, player.userId))
            .orderBy(desc(tierResultsTable.createdAt))
        : db.select().from(tierResultsTable)
            .where(sql`lower(${tierResultsTable.username}) = ${username.toLowerCase()}`)
            .orderBy(desc(tierResultsTable.createdAt)),
      player
        ? db.select().from(punishmentsTable)
            .where(eq(punishmentsTable.userId, player.userId))
            .orderBy(desc(punishmentsTable.createdAt))
        : db.select().from(punishmentsTable)
            .where(sql`lower(${punishmentsTable.username}) = ${username.toLowerCase()}`)
            .orderBy(desc(punishmentsTable.createdAt)),
    ]);

    if (!player && testResults.length === 0 && punishments.length === 0) {
      return res.status(404).json({ error: "Player not found" });
    }

    return res.json({ testResults, punishments });
  } catch (err) {
    console.error("[/api/players/:username/history] DB error:", (err as Error).message);
    return res.status(503).json({ error: "Database temporarily unavailable. Please try again." });
  }
});

export default router;
