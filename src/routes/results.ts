import { Router } from "express";
import { db, tierResultsTable } from "../lib/db.js";
import { desc, eq } from "drizzle-orm";

const router = Router();

router.get("/results/live", async (_req, res) => {
  const rows = await db.select().from(tierResultsTable).orderBy(desc(tierResultsTable.createdAt)).limit(30);
  res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30, stale-while-revalidate=30");
  return res.json({ results: rows });
});

router.get("/results/high-tier", async (_req, res) => {
  const rows = await db.select().from(tierResultsTable)
    .where(eq(tierResultsTable.isHighTier, true))
    .orderBy(desc(tierResultsTable.createdAt)).limit(30);
  res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30, stale-while-revalidate=30");
  return res.json({ results: rows });
});

export default router;
