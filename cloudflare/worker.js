const HIGH_TIERS = new Set(["HT3", "LT2", "HT2", "LT1", "HT1"]);

const MODE_COLUMNS = {
  sword: "sword_tier",
  speed: "speed_tier",
  pot: "pot_tier",
  nethop: "nethop_tier",
  ogvanilla: "ogvanilla_tier",
  vanilla: "vanilla_tier",
  uhc: "uhc_tier",
  axe: "axe_tier",
  mace: "mace_tier",
  smp: "smp_tier",
  spearmace: "spear_mace_tier",
  minecart: "minecart_tier",
  diamondsmp: "diamond_smp_tier",
};

let schemaPromise;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...extraHeaders,
    },
  });
}

function rawTierToTLevel(raw) {
  if (!raw) return "-";
  const match = String(raw).toUpperCase().match(/[1-5]$/);
  return match ? `T${match[0]}` : "-";
}

function normalizeMode(value) {
  const key = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return null;
  const aliases = { nethpot: "nethop", nethod: "nethop", crystal: "vanilla" };
  const mode = aliases[key] || key;
  return MODE_COLUMNS[mode] ? mode : null;
}

function buildPlayer(player) {
  const rawTiers = {
    current: player.current_tier,
    peak: player.peak_tier,
    ogvanilla: player.ogvanilla_tier,
    vanilla: player.vanilla_tier,
    uhc: player.uhc_tier,
    pot: player.pot_tier,
    nethop: player.nethop_tier,
    smp: player.smp_tier,
    sword: player.sword_tier,
    axe: player.axe_tier,
    mace: player.mace_tier,
    speed: player.speed_tier,
    spearmace: player.spear_mace_tier,
    minecart: player.minecart_tier,
    diamondsmp: player.diamond_smp_tier,
  };

  const tiers = {};
  for (const [mode, value] of Object.entries(rawTiers)) {
    if (mode !== "current" && mode !== "peak") tiers[mode] = rawTierToTLevel(value);
  }

  return {
    id: String(player.id),
    username: player.username,
    uuid: player.uuid || "",
    region: player.region || "EU",
    tiers,
    rawTiers,
    currentTier: rawTierToTLevel(player.current_tier),
    peakTier: rawTierToTLevel(player.peak_tier),
    updatedAt: Number(player.updated_at),
  };
}

function normalizeTier(value) {
  const key = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const match = key.match(/^(R?)(HIGH(?:TIER)?|HT|LOW(?:TIER)?|LT)([1-5])$/);
  if (!match) return null;
  return (match[1] === "R" ? "R" : "") + (/^(HIGH|HT)/.test(match[2]) ? "HT" : "LT") + match[3];
}

function buildResult(row) {
  return {
    id: row.id,
    guildId: row.guild_id,
    userId: row.user_id,
    username: row.username,
    testerId: row.tester_id || null,
    testerName: row.tester_name || null,
    tier: row.tier,
    mode: row.mode || null,
    region: row.region || null,
    ticketType: row.ticket_type || null,
    isHighTier: Boolean(row.is_high_tier),
    createdAt: Number(row.created_at),
    sourceChannelId: row.source_channel_id || null,
    sourceMessageId: row.source_message_id || null,
  };
}

async function all(env, sql, ...params) {
  return (await env.DB.prepare(sql).bind(...params).all()).results || [];
}

async function first(env, sql, ...params) {
  return (await all(env, sql, ...params))[0] || null;
}

async function run(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).run();
}

async function ensureSchema(env) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await run(env, `
        CREATE TABLE IF NOT EXISTS presence (
          client_id TEXT PRIMARY KEY,
          last_seen INTEGER NOT NULL
        )
      `);
      await run(env, "ALTER TABLE tier_results ADD COLUMN source_channel_id TEXT").catch(() => {});
      await run(env, "ALTER TABLE tier_results ADD COLUMN source_message_id TEXT").catch(() => {});
      await run(env, "CREATE UNIQUE INDEX IF NOT EXISTS tier_results_source_idx ON tier_results(source_channel_id, source_message_id) WHERE source_message_id IS NOT NULL").catch(() => {});
      await run(env, `
        CREATE TABLE IF NOT EXISTS player_name_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          uuid TEXT,
          username TEXT NOT NULL,
          observed_at INTEGER NOT NULL
        )
      `);
      await run(env, "CREATE UNIQUE INDEX IF NOT EXISTS player_name_history_identity ON player_name_history(guild_id, user_id, lower(username))").catch(() => {});
      const existingPlayers = await all(env, "SELECT guild_id, user_id, uuid, username, updated_at FROM players");
      for (const player of existingPlayers) {
        await recordPlayerName(env, player.guild_id, player.user_id, player.username, player.uuid, Number(player.updated_at) || Date.now());
      }
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

function suppliedSecret(request, body) {
  return request.headers.get("x-api-secret") || request.headers.get("x-admin-secret") || body?.secret || "";
}

function authorized(request, body, env, admin = false) {
  const expected = admin ? env.ADMIN_SECRET : env.WEBSITE_API_SECRET;
  return !expected || suppliedSecret(request, body) === expected;
}

async function recordPlayerName(env, guildId, userId, username, uuid, observedAt = Date.now()) {
  const name = String(username || "").trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return;
  await run(env, `
    INSERT OR IGNORE INTO player_name_history (guild_id, user_id, uuid, username, observed_at)
    VALUES (?, ?, ?, ?, ?)
  `, guildId, userId, uuid || null, name, observedAt);
}

async function upsertPlayer(env, player) {
  const {
    guildId,
    userId,
    username,
    uuid = null,
    region = null,
    currentTier = null,
    peakTier = null,
  } = player;
  if (!guildId || !userId || !username) return false;

  await run(env, `
    INSERT INTO players
      (guild_id, user_id, username, uuid, region, current_tier, peak_tier, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      username = excluded.username,
      uuid = COALESCE(excluded.uuid, players.uuid),
      region = COALESCE(excluded.region, players.region),
      current_tier = COALESCE(excluded.current_tier, players.current_tier),
      peak_tier = COALESCE(excluded.peak_tier, players.peak_tier),
      updated_at = excluded.updated_at
  `, guildId, userId, username, uuid, region, currentTier, peakTier, Date.now());
  await recordPlayerName(env, guildId, userId, username, uuid, Date.now());
  return true;
}

async function updateModeTier(env, guildId, userId, mode, tier) {
  const normalizedMode = normalizeMode(mode);
  const column = normalizedMode ? MODE_COLUMNS[normalizedMode] : null;
  if (!column) return;
  await run(env, `UPDATE players SET ${column} = ?, current_tier = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?`,
    tier, tier, Date.now(), guildId, userId);
}

async function repairModeTierFromHistory(env, guildId, userId, mode) {
  const normalizedMode = normalizeMode(mode);
  const column = normalizedMode ? MODE_COLUMNS[normalizedMode] : null;
  if (!column) return false;
  const latest = await first(env,
    "SELECT tier FROM tier_results WHERE guild_id = ? AND user_id = ? AND mode = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    guildId, userId, normalizedMode);
  if (!latest || !latest.tier) return false;
  await run(env, `UPDATE players SET ${column} = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?`,
    latest.tier, Date.now(), guildId, userId);
  return true;
}

async function insertResult(env, result) {
  const {
    guildId,
    userId,
    username,
    tier,
    mode = null,
    region = null,
    ticketType = null,
    testerId = null,
    testerName = null,
    createdAt = Date.now(),
    sourceChannelId = null,
    sourceMessageId = null,
  } = result;

  if (!guildId || !userId || !tier) return false;
  const storedUsername = username || `Discord user ${userId}`;
  const created = Number(createdAt) || Date.now();
  const normalizedMode = normalizeMode(mode);
  const high = HIGH_TIERS.has(String(tier).toUpperCase()) ? 1 : 0;

  if (sourceMessageId) {
    const existing = await first(env,
      "SELECT id FROM tier_results WHERE source_channel_id = ? AND source_message_id = ?",
      sourceChannelId || "", sourceMessageId);
    if (existing) {
      // Replays repair the player mirror as well as avoiding a duplicate history row.
      await upsertPlayer(env, result);
      if (normalizedMode) await updateModeTier(env, guildId, userId, normalizedMode, tier);
      return false;
    }
  } else {
    const existing = await first(env, `
      SELECT id FROM tier_results
      WHERE guild_id = ? AND user_id = ?
        AND COALESCE(mode, '') = COALESCE(?, '')
        AND tier = ? AND ABS(created_at - ?) < 10000
      LIMIT 1
    `, guildId, userId, normalizedMode, tier, created);
    if (existing) {
      // Replays repair the player mirror as well as avoiding a duplicate history row.
      await upsertPlayer(env, result);
      if (normalizedMode) await updateModeTier(env, guildId, userId, normalizedMode, tier);
      return false;
    }
  }

  await run(env, `
    INSERT INTO tier_results
      (guild_id, user_id, username, tester_id, tester_name, tier, mode, region,
       ticket_type, is_high_tier, created_at, source_channel_id, source_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, guildId, userId, storedUsername, testerId, testerName, tier, normalizedMode,
    region, ticketType, high, created, sourceChannelId, sourceMessageId);

  await upsertPlayer(env, {
    guildId,
    userId,
    username: storedUsername,
    region,
    currentTier: tier,
  });
  await updateModeTier(env, guildId, userId, normalizedMode, tier);
  return true;
}

async function handlePlayers(env, parts) {
  if (parts.length === 1) {
    const rows = await all(env, "SELECT * FROM players ORDER BY updated_at DESC, id DESC");
    const seen = new Set();
    const players = rows
      .filter((row) => {
        const key = String(row.username).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(buildPlayer);
    return json({ players }, 200, { "cache-control": "no-store" });
  }

  if (parts.length === 3 && parts[2] === "history") {
    const username = decodeURIComponent(parts[1]);
    const player = await first(env, "SELECT user_id FROM players WHERE lower(username) = lower(?) LIMIT 1", username);
    const resultRows = player
      ? await all(env, "SELECT * FROM tier_results WHERE lower(username) = lower(?) OR user_id = ? ORDER BY created_at DESC LIMIT 500", username, player.user_id)
      : await all(env, "SELECT * FROM tier_results WHERE lower(username) = lower(?) ORDER BY created_at DESC LIMIT 500", username);
    const punishmentRows = player
      ? await all(env, "SELECT * FROM punishments WHERE lower(username) = lower(?) OR user_id = ? ORDER BY created_at DESC", username, player.user_id)
      : await all(env, "SELECT * FROM punishments WHERE lower(username) = lower(?) ORDER BY created_at DESC", username);
    const nameHistoryRows = player
      ? await all(env, "SELECT username, uuid, observed_at FROM player_name_history WHERE user_id = ? ORDER BY observed_at DESC, id DESC", player.user_id)
      : await all(env, "SELECT username, uuid, observed_at FROM player_name_history WHERE lower(username) = lower(?) ORDER BY observed_at DESC, id DESC", username);

    return json({
      testResults: resultRows.map(buildResult),
      punishments: punishmentRows.map((row) => ({
        id: row.id,
        type: row.type,
        reason: row.reason || null,
        durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
        expiresAt: row.expires_at == null ? null : Number(row.expires_at),
        active: Boolean(row.active),
        pardonedBy: row.pardoned_by || null,
        pardonedAt: row.pardoned_at == null ? null : Number(row.pardoned_at),
        moderatorId: row.moderator_id || null,
        moderatorName: row.moderator_name || null,
        createdAt: Number(row.created_at),
      })),
      nameHistory: nameHistoryRows.map((row) => ({
        username: row.username,
        uuid: row.uuid || null,
        observedAt: Number(row.observed_at),
      })),
    }, 200, { "cache-control": "public, max-age=30" });
  }

  if (parts.length === 2 && parts[1] === "by-discord") return json({ error: "Invalid player path" }, 400);

  const username = decodeURIComponent(parts[1] || "");
  const row = await first(env, "SELECT * FROM players WHERE lower(username) = lower(?) ORDER BY updated_at DESC LIMIT 1", username);
  if (!row) return json({ error: "Player not found" }, 404);
  const nameHistory = await all(env,
    "SELECT username, uuid, observed_at FROM player_name_history WHERE user_id = ? ORDER BY observed_at DESC, id DESC",
    row.user_id);
  return json({
    ...buildPlayer(row),
    nameHistory: nameHistory.map((entry) => ({
      username: entry.username,
      uuid: entry.uuid || null,
      observedAt: Number(entry.observed_at),
    })),
  }, 200, { "cache-control": "public, max-age=30" });
}

async function handleRequest(request, env) {
  await ensureSchema(env);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type,x-api-secret,x-admin-secret",
      },
    });
  }

  if (path === "/") return json({ status: "ok", service: "outertiers-api" });
  const apiPath = path.startsWith("/api/") ? path.slice(5) : path === "/api" ? "" : null;
  if (apiPath === null) return json({ error: "Not found" }, 404);
  const parts = apiPath.split("/").filter(Boolean);

  if (request.method === "GET" && parts[0] === "healthz") {
    return json({ status: "ok", v: 6, timestamp: Date.now() });
  }

  if (request.method === "GET" && parts[0] === "players") {
    if (parts[1] === "by-discord" && parts[2]) {
      const row = await first(env, "SELECT * FROM players WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1", parts[2]);
      return row ? json(buildPlayer(row)) : json({ error: "Player not found" }, 404);
    }
    return handlePlayers(env, parts);
  }

  if (request.method === "GET" && parts[0] === "results" && parts[1] === "live") {
    const rows = await all(env, "SELECT * FROM tier_results ORDER BY created_at DESC, id DESC LIMIT 30");
    return json({ results: rows.map(buildResult) }, 200, { "cache-control": "public, max-age=30" });
  }

  if (request.method === "GET" && parts[0] === "results" && parts[1] === "high-tier") {
    const rows = await all(env, "SELECT * FROM tier_results WHERE is_high_tier = 1 ORDER BY created_at DESC, id DESC LIMIT 30");
    return json({ results: rows.map(buildResult) }, 200, { "cache-control": "public, max-age=30" });
  }

  if (request.method === "GET" && parts[0] === "presence") {
    await run(env, "DELETE FROM presence WHERE last_seen < ?", Date.now() - 120000);
    const rows = await all(env, "SELECT COUNT(*) AS count FROM presence");
    return json({ online: Number(rows[0]?.count || 0) });
  }

  if (request.method === "POST" && parts[0] === "presence") {
    const body = await request.json().catch(() => ({}));
    if (!body.id) return json({ error: "id required" }, 400);
    await run(env, "INSERT INTO presence (client_id, last_seen) VALUES (?, ?) ON CONFLICT(client_id) DO UPDATE SET last_seen = excluded.last_seen", String(body.id), Date.now());
    await run(env, "DELETE FROM presence WHERE last_seen < ?", Date.now() - 120000);
    const rows = await all(env, "SELECT COUNT(*) AS count FROM presence");
    return json({ online: Number(rows[0]?.count || 0) });
  }

  if (request.method === "POST" && parts[0] === "migrate") {
    const body = await request.json().catch(() => ({}));
    if (!authorized(request, body, env) || !Array.isArray(body.players)) return json({ error: "Unauthorized or invalid players" }, 401);
    let inserted = 0;
    for (const player of body.players) {
      if (await upsertPlayer(env, player)) {
        for (const [mode, tier] of Object.entries(player)) {
          if (mode.endsWith("Tier") && tier) await updateModeTier(env, player.guildId, player.userId, mode.slice(0, -4), tier);
        }
        inserted++;
      }
    }
    return json({ ok: true, inserted });
  }

  if (request.method === "POST" && parts[0] === "webhook") {
    const body = await request.json().catch(() => ({}));
    if (!authorized(request, body, env)) return json({ error: "Unauthorized" }, 401);

    if (parts[1] === "bulk-results") {
      if (!Array.isArray(body.results) || body.results.length === 0) return json({ error: "results array required" }, 400);
      let inserted = 0;
      for (const result of body.results) if (await insertResult(env, result)) inserted++;
      return json({ ok: true, inserted, skipped: body.results.length - inserted });
    }

    if (parts[1] === "tier") {
      if (!body.guildId || !body.userId) return json({ error: "guildId and userId are required" }, 400);

      if (body.type === "update-username") {
        const username = String(body.username || "").trim();
        if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
          return json({ error: "A valid Minecraft username is required" }, 422);
        }
        const normalizedUuid = body.uuid
          ? String(body.uuid).replace(/-/g, "").toLowerCase()
          : null;
        const existing = await first(env,
          "SELECT * FROM players WHERE guild_id = ? AND user_id = ? LIMIT 1",
          body.guildId, body.userId);
        let target = existing;
        let historyUserIds = [String(body.userId)];
        if (!target && normalizedUuid && /^[0-9a-f]{32}$/.test(normalizedUuid)) {
          target = await first(env,
            "SELECT * FROM players WHERE guild_id = ? AND lower(uuid) = lower(?) LIMIT 1",
            body.guildId, normalizedUuid);
          if (target) historyUserIds = [...new Set([String(body.userId), String(target.user_id)])];
        }
        if (!target) return json({ error: "Player not found" }, 404);
        const storedUuid = target.uuid ? String(target.uuid).replace(/-/g, "").toLowerCase() : null;
        if (storedUuid && normalizedUuid && storedUuid !== normalizedUuid) {
          return json({ error: "Minecraft UUID does not match the stored player identity" }, 409);
        }
        await recordPlayerName(env, target.guild_id, target.user_id, target.username, storedUuid, Date.now());
        await run(env, `
          UPDATE players SET username = ?, uuid = COALESCE(?, uuid), updated_at = ?
          WHERE id = ?
        `, username, normalizedUuid, Date.now(), target.id);
        for (const historyUserId of historyUserIds) {
          await run(env, "UPDATE tier_results SET username = ? WHERE guild_id = ? AND user_id = ?",
            username, body.guildId, historyUserId);
          await run(env, "UPDATE punishments SET username = ? WHERE guild_id = ? AND user_id = ?",
            username, body.guildId, historyUserId);
          await recordPlayerName(env, body.guildId, historyUserId, username, normalizedUuid || storedUuid, Date.now());
        }
        return json({ ok: true });
      }

      // tierwipe must clear the requested player column, not perform a normal upsert.
      if (body.type === "tierwipe") {
        const existing = await first(env, "SELECT id FROM players WHERE guild_id = ? AND user_id = ? LIMIT 1", body.guildId, body.userId);
        if (!existing) return json({ error: "Player not found for guildId and userId" }, 404);

        if (body.scope === "mode") {
          const mode = normalizeMode(body.mode);
          if (!mode) return json({ error: "Unsupported tier mode" }, 400);
          const column = MODE_COLUMNS[mode];
          const changed = await run(env, "UPDATE players SET " + column + " = NULL, updated_at = ? WHERE guild_id = ? AND user_id = ?", Date.now(), body.guildId, body.userId);
          return json({ ok: true, updated: Number(changed?.meta?.changes || 0), mode });
        }

        if (body.scope === "specific") {
          const tier = normalizeTier(body.tier);
          if (!tier) return json({ error: "Unsupported tier" }, 400);
          const columns = ["current_tier", ...new Set(Object.values(MODE_COLUMNS))];
          const assignments = columns.map((column) => column + " = CASE WHEN upper(" + column + ") = ? THEN NULL ELSE " + column + " END");
          const changed = await run(env, "UPDATE players SET " + assignments.join(", ") + ", updated_at = ? WHERE guild_id = ? AND user_id = ?", ...columns.map(() => tier), Date.now(), body.guildId, body.userId);
          return json({ ok: true, updated: Number(changed?.meta?.changes || 0), scope: "specific", tier });
        }

        const cleared = await run(env, "UPDATE players SET current_tier = NULL, peak_tier = NULL, ogvanilla_tier = NULL, vanilla_tier = NULL, uhc_tier = NULL, pot_tier = NULL, nethop_tier = NULL, smp_tier = NULL, sword_tier = NULL, axe_tier = NULL, mace_tier = NULL, speed_tier = NULL, spear_mace_tier = NULL, minecart_tier = NULL, diamond_smp_tier = NULL, updated_at = ? WHERE guild_id = ? AND user_id = ?", Date.now(), body.guildId, body.userId);
        await run(env, "DELETE FROM tier_results WHERE guild_id = ? AND user_id = ?", body.guildId, body.userId);
        return json({ ok: true, updated: Number(cleared?.meta?.changes || 0), scope: "all" });
      }

      if (!body.username) return json({ error: "guildId, userId and username are required" }, 400);
      await upsertPlayer(env, {
        ...body,
        // The webhook uses tier; map it explicitly to the player mirror.
        currentTier: body.tier ?? body.currentTier ?? null,
      });
      if (body.tier) {
        await insertResult(env, { ...body, currentTier: body.tier });
        // Repair the denormalized mode column when an older history row was
        // written without updating the player mirror.
        const normalizedMode = normalizeMode(body.mode);
        if (normalizedMode) await repairModeTierFromHistory(env, body.guildId, body.userId, normalizedMode);
      }
      return json({ ok: true });
    }

    if (parts[1] === "bulk-punishments") {
      if (!Array.isArray(body.punishments) || body.punishments.length === 0) return json({ error: "punishments array required" }, 400);
      let inserted = 0;
      for (const punishment of body.punishments) {
        if (!punishment.guildId || !punishment.userId || !punishment.type) continue;
        const existing = await first(env, "SELECT id FROM punishments WHERE guild_id = ? AND user_id = ? AND type = ? AND ABS(created_at - ?) < 10000 LIMIT 1",
          punishment.guildId, punishment.userId, punishment.type, Number(punishment.createdAt) || Date.now());
        if (existing) continue;
        await run(env, `
          INSERT INTO punishments
            (guild_id, user_id, username, moderator_id, moderator_name, type, reason,
             duration_ms, expires_at, active, pardoned_by, pardoned_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, punishment.guildId, punishment.userId, punishment.username || `Discord user ${punishment.userId}`,
          punishment.moderatorId || null, punishment.moderatorName || null, punishment.type,
          punishment.reason || null, punishment.durationMs || null, punishment.expiresAt || null,
          punishment.active === false ? 0 : 1, punishment.pardonedBy || null, punishment.pardonedAt || null,
          Number(punishment.createdAt) || Date.now());
        inserted++;
      }
      return json({ ok: true, inserted, skipped: body.punishments.length - inserted });
    }

    if (parts[1] === "fix-result-modes") {
      if (!Array.isArray(body.updates) || body.updates.length === 0) return json({ error: "updates array required" }, 400);
      let patched = 0;
      let skipped = 0;
      for (const update of body.updates) {
        const mode = normalizeMode(update.mode);
        const tier = normalizeTier(update.tier);
        const createdAt = Number(update.createdAt);
        const timestamp = createdAt < 1e12 ? createdAt * 1000 : createdAt;
        if (!update.guildId || !update.userId || !mode || !tier || !Number.isFinite(timestamp) || timestamp <= 0) { skipped++; continue; }
        const result = await run(env, "UPDATE tier_results SET mode = ? WHERE guild_id = ? AND user_id = ? AND mode IS NULL AND ABS(created_at - ?) <= 15000", mode, update.guildId, update.userId, timestamp);
        const count = Number(result?.meta?.changes || 0);
        if (!count) { skipped++; continue; }
        patched += count;
        const column = MODE_COLUMNS[mode];
        await run(env, "UPDATE players SET " + column + " = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?", tier, Date.now(), update.guildId, update.userId);
      }
      return json({ ok: true, patched, skipped });
    }
    if (parts[1] === "punishment") {
      if (!body.guildId || !body.userId || !body.type) return json({ error: "guildId, userId and type are required" }, 400);
      await run(env, `
        INSERT INTO punishments
          (guild_id, user_id, username, moderator_id, moderator_name, type, reason,
           duration_ms, expires_at, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, body.guildId, body.userId, body.username || `Discord user ${body.userId}`,
        body.moderatorId || null, body.moderatorName || null, body.type, body.reason || null,
        body.durationMs || null, body.expiresAt || null, 1, Number(body.createdAt) || Date.now());
      return json({ ok: true });
    }

    if (parts[1] === "pardon") {
      await run(env, "UPDATE punishments SET active = 0, pardoned_by = ?, pardoned_at = ? WHERE guild_id = ? AND user_id = ? AND active = 1",
        body.pardonedBy || null, Number(body.pardonedAt) || Date.now(), body.guildId, body.userId);
      return json({ ok: true });
    }
  }

  if (request.method === "GET" && parts[0] === "admin" && parts[1] === "results") {
    if (!authorized(request, {}, env, true)) return json({ error: "Unauthorized" }, 401);
    const limit = Math.min(Number(url.searchParams.get("limit") || 50), 500);
    const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
    const search = url.searchParams.get("search") || "";
    const rows = search
      ? await all(env, "SELECT * FROM tier_results WHERE lower(username) LIKE lower(?) ORDER BY created_at DESC LIMIT ? OFFSET ?", `%${search}%`, limit, offset)
      : await all(env, "SELECT * FROM tier_results ORDER BY created_at DESC LIMIT ? OFFSET ?", limit, offset);
    const count = search
      ? await first(env, "SELECT COUNT(*) AS count FROM tier_results WHERE lower(username) LIKE lower(?)", `%${search}%`)
      : await first(env, "SELECT COUNT(*) AS count FROM tier_results");
    return json({ results: rows.map(buildResult), total: Number(count?.count || 0) });
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("[outertiers-api]", error?.stack || error);
      return json({ error: "Internal Server Error", detail: error?.message || String(error) }, 500);
    }
  },
};