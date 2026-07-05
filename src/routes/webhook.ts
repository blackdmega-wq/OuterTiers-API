import { Router } from "express";
import { db, playersTable, tierResultsTable, punishmentsTable } from "../lib/db.js";
import { and, eq, between, desc, isNull } from "drizzle-orm";

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

function requireSecret(req: any, res: any): boolean {
  const secret = req.body?.secret as string | undefined;
  if (!secret || secret !== process.env.WEBSITE_API_SECRET)
    return (res.status(401).json({ error: "Unauthorized" }), false);
  return true;
}

// ── Single tier result (posted in real-time when a test is completed) ─────────

router.post("/webhook/tier", async (req, res) => {
  const { secret, type, guildId, userId, username, discordUsername,
          tier, peakTier, mode, region, testerId, testerName, ticketType }
    = req.body as Record<string, string | undefined>;

  if (!secret || secret !== process.env.WEBSITE_API_SECRET)
    return res.status(401).json({ error: "Unauthorized" });
  if (!guildId || !userId)
    return res.status(400).json({ error: "Missing required fields: guildId, userId" });

  try {
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

    // ── Update username only (called by IGN auto-sync when a rename is detected) ──
    if (type === "update-username") {
      if (!username) return res.status(400).json({ error: "Missing username" });
      const existing = await db.select({ id: playersTable.id }).from(playersTable).where(where).limit(1);
      if (existing.length > 0) {
        await db.update(playersTable).set({ username, updatedAt: now }).where(where);
      }
      // If player not in website DB yet (no test results) — nothing to update, that's fine.
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
  } catch (err) {
    console.error("[/api/webhook/tier] DB error:", (err as Error).message);
    return res.status(503).json({ error: "Database temporarily unavailable. Please try again." });
  }
});

// ── Bulk results backfill (used by /synctesthistory bot command) ──────────────
// Deduplicates on (guildId, userId, mode, createdAt ±10 s).

router.post("/webhook/bulk-results", async (req, res) => {
  if (!requireSecret(req, res)) return;

  const { results } = req.body as { results?: any[] };
  if (!Array.isArray(results) || results.length === 0)
    return res.status(400).json({ error: "results must be a non-empty array" });

  let inserted = 0;
  let skipped = 0;
  const WINDOW = 10_000; // ±10 s dedup window

  // Sort ascending so the newest row is processed last — guarantees newest tier wins.
  const sorted = [...results].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

  for (const r of sorted) {
    const { guildId, userId, username, tier, mode, region, ticketType, testerId, testerName, createdAt } = r;
    if (!guildId || !userId || !tier) { skipped++; continue; }

    const upperTier = String(tier).toUpperCase();
    const isHighTier = HIGH_TIERS.has(upperTier);
    const ts = typeof createdAt === "number" ? createdAt : Date.now();

    try {
      // Dedup: check for an existing row within ±10 s with same userId + mode
      const existing = await db
        .select({ id: tierResultsTable.id })
        .from(tierResultsTable)
        .where(
          and(
            eq(tierResultsTable.guildId, guildId),
            eq(tierResultsTable.userId, userId),
            eq(tierResultsTable.tier, upperTier),
            mode
              ? and(eq(tierResultsTable.mode, mode), between(tierResultsTable.createdAt, ts - WINDOW, ts + WINDOW))
              : between(tierResultsTable.createdAt, ts - WINDOW, ts + WINDOW),
          )
        )
        .limit(1);

      if (existing.length > 0) { skipped++; continue; }

      // Resolve username from players table if not provided
      let resolvedUsername = username;
      if (!resolvedUsername) {
        const playerRows = await db
          .select({ username: playersTable.username })
          .from(playersTable)
          .where(and(eq(playersTable.guildId, guildId), eq(playersTable.userId, userId)))
          .limit(1);
        resolvedUsername = playerRows[0]?.username ?? userId;
      }

      await db.insert(tierResultsTable).values({
        guildId, userId,
        username: resolvedUsername,
        testerId: testerId ?? null,
        testerName: testerName ?? null,
        tier: upperTier,
        mode: mode ?? null,
        region: region ?? null,
        ticketType: ticketType ?? null,
        isHighTier,
        createdAt: ts,
      });

      // Upsert player so /api/players/:username returns data even after a pure backfill.
      // We set the mode-specific tier column only if the result has a mode.
      const modeUpdate = buildModeUpdate(mode, upperTier);
      const playerWhere = and(
        eq(playersTable.guildId, guildId),
        eq(playersTable.userId, userId),
      );
      const existingPlayer = await db
        .select({ id: playersTable.id })
        .from(playersTable)
        .where(playerWhere)
        .limit(1);

      if (existingPlayer.length > 0) {
        // Update mode column + currentTier + updatedAt.
        // Since results are sorted ascending by createdAt, the last processed row
        // has the newest ts, so currentTier will correctly end up as the latest value.
        await db.update(playersTable)
          .set({ username: resolvedUsername, currentTier: upperTier, updatedAt: ts, ...modeUpdate })
          .where(playerWhere);
      } else {
        await db.insert(playersTable).values({
          guildId, userId,
          username: resolvedUsername,
          discordUsername: null,
          region: region ?? null,
          currentTier: upperTier,
          updatedAt: ts,
          ...modeUpdate,
        });
      }

      inserted++;
    } catch (err) {
      console.error("[/api/webhook/bulk-results] row error:", (err as Error).message);
      skipped++;
    }
  }

  return res.json({ ok: true, inserted, skipped });
});

// ── Single punishment (posted in real-time when a punishment is applied) ──────

router.post("/webhook/punishment", async (req, res) => {
  if (!requireSecret(req, res)) return;

  const { guildId, userId, username, type, reason, durationMs, expiresAt,
          moderatorId, moderatorName, createdAt } = req.body as Record<string, any>;

  if (!guildId || !userId || !type)
    return res.status(400).json({ error: "Missing required fields: guildId, userId, type" });

  try {
    const displayName = username || userId;
    await db.insert(punishmentsTable).values({
      guildId, userId,
      username: displayName,
      type: String(type),
      reason: reason ?? null,
      durationMs: typeof durationMs === "number" ? durationMs : null,
      expiresAt: typeof expiresAt === "number" ? expiresAt : null,
      active: true,
      pardonedBy: null,
      pardonedAt: null,
      moderatorId: moderatorId ?? null,
      moderatorName: moderatorName ?? null,
      createdAt: typeof createdAt === "number" ? createdAt : Date.now(),
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[/api/webhook/punishment] DB error:", (err as Error).message);
    return res.status(503).json({ error: "Database temporarily unavailable. Please try again." });
  }
});

// ── Bulk punishments backfill (used by /synctesthistory bot command) ──────────

router.post("/webhook/bulk-punishments", async (req, res) => {
  if (!requireSecret(req, res)) return;

  const { punishments } = req.body as { punishments?: any[] };
  if (!Array.isArray(punishments) || punishments.length === 0)
    return res.status(400).json({ error: "punishments must be a non-empty array" });

  let inserted = 0;
  let skipped = 0;
  const WINDOW = 10_000;

  for (const p of punishments) {
    const { guildId, userId, username, type, reason, durationMs, expiresAt,
            active, pardonedBy, pardonedAt, moderatorId, moderatorName, createdAt } = p;
    if (!guildId || !userId || !type) { skipped++; continue; }

    const ts = typeof createdAt === "number" ? createdAt : Date.now();

    try {
      const existing = await db
        .select({ id: punishmentsTable.id })
        .from(punishmentsTable)
        .where(
          and(
            eq(punishmentsTable.guildId, guildId),
            eq(punishmentsTable.userId, userId),
            eq(punishmentsTable.type, String(type)),
            between(punishmentsTable.createdAt, ts - WINDOW, ts + WINDOW),
          )
        )
        .limit(1);

      if (existing.length > 0) { skipped++; continue; }

      const displayName = username || userId;
      await db.insert(punishmentsTable).values({
        guildId, userId,
        username: displayName,
        type: String(type),
        reason: reason ?? null,
        durationMs: typeof durationMs === "number" ? durationMs : null,
        expiresAt: typeof expiresAt === "number" ? expiresAt : null,
        active: active !== false,
        pardonedBy: pardonedBy ?? null,
        pardonedAt: typeof pardonedAt === "number" ? pardonedAt : null,
        moderatorId: moderatorId ?? null,
        moderatorName: moderatorName ?? null,
        createdAt: ts,
      });
      inserted++;
    } catch (err) {
      console.error("[/api/webhook/bulk-punishments] row error:", (err as Error).message);
      skipped++;
    }
  }

  return res.json({ ok: true, inserted, skipped });
});

// ── Pardon (mark most recent active punishment as pardoned) ───────────────────

router.post("/webhook/pardon", async (req, res) => {
  if (!requireSecret(req, res)) return;

  const { guildId, userId, pardonedBy, pardonedAt } = req.body as Record<string, any>;
  if (!guildId || !userId)
    return res.status(400).json({ error: "Missing required fields: guildId, userId" });

  try {
    // Find the most recent active punishment for this user
    const active = await db
      .select({ id: punishmentsTable.id })
      .from(punishmentsTable)
      .where(
        and(
          eq(punishmentsTable.guildId, guildId),
          eq(punishmentsTable.userId, userId),
          eq(punishmentsTable.active, true),
        )
      )
      .orderBy(desc(punishmentsTable.createdAt))
      .limit(1);

    if (active.length === 0) return res.json({ ok: true, updated: 0 });

    await db
      .update(punishmentsTable)
      .set({
        active: false,
        pardonedBy: pardonedBy ?? null,
        pardonedAt: typeof pardonedAt === "number" ? pardonedAt : Date.now(),
      })
      .where(eq(punishmentsTable.id, active[0].id));

    return res.json({ ok: true, updated: 1 });
  } catch (err) {
    console.error("[/api/webhook/pardon] DB error:", (err as Error).message);
    return res.status(503).json({ error: "Database temporarily unavailable. Please try again." });
  }
});

// ── Patch missing mode on existing null-mode tier_results rows ───────────────
// Used by /fixresultmodes bot command to backfill gamemodes from ticket records.
router.post("/webhook/fix-result-modes", async (req, res) => {
  if (!requireSecret(req, res)) return;

  const { updates } = req.body as { updates?: any[] };
  if (!Array.isArray(updates) || updates.length === 0)
    return res.status(400).json({ error: "updates must be a non-empty array" });

  let patched = 0;
  let skipped = 0;
  const WINDOW = 15_000; // ±15 s match window

  for (const u of updates) {
    const { userId, createdAt, mode } = u;
    if (!userId || !createdAt || !mode) { skipped++; continue; }
    const ts = Number(createdAt);
    try {
      const result = await db
        .update(tierResultsTable)
        .set({ mode: String(mode).toLowerCase() })
        .where(
          and(
            eq(tierResultsTable.userId, userId),
            isNull(tierResultsTable.mode),
            between(tierResultsTable.createdAt, ts - WINDOW, ts + WINDOW),
          )
        );
      const count = (result as any).rowCount ?? 0;
      if (count > 0) patched += count; else skipped++;
    } catch (err) {
      console.error("[/api/webhook/fix-result-modes] error:", (err as Error).message);
      skipped++;
    }
  }

  return res.json({ ok: true, patched, skipped });
});

export default router;
