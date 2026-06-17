import { db, playersTable } from "./db.js";
import { eq, and, isNull } from "drizzle-orm";
import { logger } from "./logger.js";

const MOJANG_BY_NAME = "https://api.mojang.com/users/profiles/minecraft/";
const MOJANG_BY_UUID = "https://sessionserver.mojang.com/session/minecraft/profile/";

/** Fetch UUID for a Minecraft username. Returns null if the account doesn't exist (cracked/renamed). */
export async function lookupUUID(username: string): Promise<string | null> {
  try {
    const res = await fetch(`${MOJANG_BY_NAME}${encodeURIComponent(username)}`);
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) return null;
    const data = await res.json() as { id?: string };
    return data.id ?? null;
  } catch {
    return null;
  }
}

/** Fetch current username for a UUID. Returns null on failure. */
export async function lookupCurrentUsername(uuid: string): Promise<string | null> {
  try {
    const res = await fetch(`${MOJANG_BY_UUID}${uuid}`);
    if (!res.ok) return null;
    const data = await res.json() as { name?: string };
    return data.name ?? null;
  } catch {
    return null;
  }
}

/** Pause execution for ms milliseconds (rate-limit guard). */
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Full sync pass:
 * 1. For every player WITHOUT a UUID: look up their Mojang UUID and store it.
 * 2. For every player WITH a UUID: fetch current username and update if it changed.
 *
 * Mojang rate-limit is ~600 req/10min per IP. We sleep 200ms between calls to stay safe.
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
    await sleep(200);

    if (!player.uuid) {
      // No UUID stored yet — look it up by current username
      const uuid = await lookupUUID(player.username);
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
      const currentName = await lookupCurrentUsername(player.uuid);
      if (!currentName) continue;

      if (currentName.toLowerCase() !== player.username.toLowerCase()) {
        const oldName = player.username;
        await db.update(playersTable)
          .set({ username: currentName, updatedAt: Date.now() })
          .where(eq(playersTable.id, player.id));
        renamed++;
        logger.info({ oldName, newName: currentName, uuid: player.uuid }, "Username auto-updated (rename detected)");
      }
    }
  }

  logger.info({ synced, renamed, cracked }, "Mojang sync complete");
  return { synced, renamed, cracked };
}
