import { db, tierResultsTable } from "./db.js";
import { inArray, eq, and, not } from "drizzle-orm";
import { logger } from "./logger.js";

// Historical rows may have is_high_tier=false because the HIGH_TIERS set used
// to compute it at insert-time didn't yet include retired tiers (RLT2/RHT2/
// RLT1/RHT1) or was otherwise out of date. This runs once at every boot and
// corrects any rows whose tier now qualifies as high-tier but is flagged
// false. It's idempotent — safe to run on every startup.
const HIGH_TIERS = ["HT3", "LT2", "HT2", "LT1", "HT1", "RLT2", "RHT2", "RLT1", "RHT1"];

export async function backfillHighTier(): Promise<void> {
  try {
    const result = await db
      .update(tierResultsTable)
      .set({ isHighTier: true })
      .where(
        and(
          inArray(tierResultsTable.tier, HIGH_TIERS),
          not(eq(tierResultsTable.isHighTier, true)),
        )
      );
    const count = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    if (count > 0) logger.info({ count }, "[backfillHighTier] Patched historical is_high_tier flags");
  } catch (err) {
    logger.error({ err }, "[backfillHighTier] failed");
  }
}
