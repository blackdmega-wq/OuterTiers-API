import { db, playersTable, tierResultsTable, punishmentsTable } from "./db.js";
import { eq, and, isNull } from "drizzle-orm";
import { logger } from "./logger.js";

const MOJANG_BY_NAME = "https://api.mojang.com/users/profiles/minecraft/";
const MOJANG_BY_UUID = "https://sessionserver.mojang.com/session/minecraft/profile/";
const MC_NAME_RE = /^[a-zA-Z0-9_]{3,16}$/;
const MC_UUID_RE = /^[0-9a-f]{32}$/i;
const MOJANG_RETRY_ATTEMPTS = Math.max(2, Math.min(5, Number(process.env.MOJANG_RETRY_ATTEMPTS || 4)));
const MOJANG_RETRY_BASE_MS = Math.max(1000, Number(process.env.MOJANG_RETRY_BASE_MS || 2000));
const MOJANG_REQUEST_INTERVAL_MS = Math.max(1000, Number(process.env.MOJANG_REQUEST_INTERVAL_MS || 1000));
let lastMojangRequestAt = 0;

function normalizeUuid(value: string | null | undefined): string | null {
  const compact = String(value ?? "").replace(/-/g, "").trim().toLowerCase();
  return MC_UUID_RE.test(compact) ? compact : null;
}

/** Pause execution for ms milliseconds. */
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitForMojangSlot(): Promise<void> {
  const waitMs = Math.max(0, MOJANG_REQUEST_INTERVAL_MS - (Date.now() - lastMojangRequestAt));
  if (waitMs > 0) await sleep(waitMs);
  lastMojangRequestAt = Date.now();
}

async function requestMojangJson(url: string): Promise<Record<string, unknown> | null> {
  for (let attempt = 1; attempt <= MOJANG_RETRY_ATTEMPTS; attempt++) {
    await waitForMojangSlot();
    try {
      const res = await fetch(url, { headers: { "User-Agent": "OuterTiers-API/1.0" } });
      if (res.status === 404 || res.status === 204) return null;
      if (res.ok) return await res.json() as Record<string, unknown>;

      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (!retryable || attempt === MOJANG_RETRY_ATTEMPTS) return null;
    } catch {
      if (attempt === MOJANG_RETRY_ATTEMPTS) return null;
    }
    await sleep(MOJANG_RETRY_BASE_MS * (2 ** (attempt - 1)));
  }
  return null;
}

/** Fetch UUID for a Minecraft username. Returns null if the account doesn't exist (cracked/renamed). */
export async function lookupUUID(username: string): Promise<string | null> {
  const data = await requestMojangJson(`${MOJANG_BY_NAME}${encodeURIComponent(username)}`);
  return typeof data?.id === "string" ? normalizeUuid(data.id) : null;
}

/** Fetch current username for a UUID. Returns null on failure. */
export async function lookupCurrentUsername(uuid: string): Promise<string | null> {
  const data = await requestMojangJson(`${MOJANG_BY_UUID}${encodeURIComponent(uuid)}`);
  return typeof data?.name === "string" ? data.name : null;
}

/**
 * Full sync pass:
 * 1. For every player WITHOUT a UUID: look up their Mojang UUID and store it.
 * 2. For every player WITH a UUID: fetch current username and update if it changed.
 *
 * Mojang rate-limit is ~600 req/10min per IP. The request helper spaces calls
 * at roughly one per second and retries transient failures with backoff.
 */
export async function syncAllPlayers(): Promise<{ synced: number; renamed: number; cracked: number }> {
  let synced = 0;
  let renamed = 0;
  let cracked = 0;

  const players = await db.select({
    id: playersTable.id,
    userId: playersTable.userId,
    guildId: playersTable.guildId,
    username: playersTable.username,
    uuid: playersTable.uuid,
  }).from(playersTable);

  for (const player of players) {
    const storedUuid = normalizeUuid(player.uuid);
    if (!storedUuid) {
      // No UUID stored yet — look it up by current username
      const uuid = MC_NAME_RE.test(player.username) ? await lookupUUID(player.username) : null;
      if (uuid) {
        await db.update(playersTable)
          .set({ uuid, updatedAt: Date.now() })
          .where(eq(playersTable.id, player.id));
        synced++;
        logger.info({ username: player.username, uuid }, "UUID synced");
      } else {
        // Username not on Mojang — cracked / offline-mode player
        cracked++;
        logger.warn({ username: player.username }, "No Mojang UUID found — cracked or offline player");
      }
    } else {
      // UUID already known — check if they renamed
      const currentName = await lookupCurrentUsername(storedUuid);
      if (!currentName) {
        // Older bot versions stored a random UUID when a profile had no
        // verified UUID. If the stored name is valid, resolve it by name and
        // replace the random value with Mojang's canonical UUID.
        if (MC_NAME_RE.test(player.username)) {
          const resolvedUuid = await lookupUUID(player.username);
          if (resolvedUuid && resolvedUuid !== storedUuid) {
            await db.update(playersTable)
              .set({ uuid: resolvedUuid, updatedAt: Date.now() })
              .where(eq(playersTable.id, player.id));
            synced++;
            logger.info({ username: player.username, oldUuid: storedUuid, uuid: resolvedUuid }, "Generated UUID replaced");
          }
        } else {
          cracked++;
          logger.warn({ username: player.username, uuid: storedUuid }, "Unverified username hidden from public player data");
        }
        continue;
      }

      if (currentName.toLowerCase() !== player.username.toLowerCase()) {
        const oldName = player.username;
        await db.transaction(async (tx) => {
          const update = { username: currentName, uuid: storedUuid, updatedAt: Date.now() };
          await tx.update(playersTable)
            .set(update)
            .where(eq(playersTable.id, player.id));
          // Keep feeds and profile history consistent with the canonical
          // Minecraft name. The profile itself is keyed by Discord user ID,
          // so old history rows must be updated by guild + user as well.
          await tx.update(tierResultsTable)
            .set({ username: currentName })
            .where(and(
              eq(tierResultsTable.guildId, player.guildId),
              eq(tierResultsTable.userId, player.userId),
            ));
          await tx.update(punishmentsTable)
            .set({ username: currentName })
            .where(and(
              eq(punishmentsTable.guildId, player.guildId),
              eq(punishmentsTable.userId, player.userId),
            ));
        });
        renamed++;
        logger.info({ oldName, newName: currentName, uuid: player.uuid }, "Username auto-updated (rename detected)");
      }
    }
  }

  logger.info({ synced, renamed, cracked }, "Mojang sync complete");
  return { synced, renamed, cracked };
}
