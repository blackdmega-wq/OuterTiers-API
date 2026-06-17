import app from "./app.js";
import { logger } from "./lib/logger.js";
import { syncAllPlayers } from "./lib/mojangSync.js";

const rawPort = process.env["PORT"] ?? "3000";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, () => {
  logger.info({ port }, "Server listening");

  // Run UUID + rename sync shortly after startup (non-blocking)
  setTimeout(() => {
    syncAllPlayers().catch(err => logger.error({ err }, "Startup Mojang sync failed"));
  }, 5_000);

  // Re-sync every 6 hours to catch renames
  setInterval(() => {
    syncAllPlayers().catch(err => logger.error({ err }, "Scheduled Mojang sync failed"));
  }, 6 * 60 * 60 * 1_000);
});
