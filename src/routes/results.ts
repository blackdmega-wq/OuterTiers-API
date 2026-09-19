import { Router } from "express";
import { db, tierResultsTable } from "../lib/db.js";
import { desc, eq } from "drizzle-orm";

const router = Router();
const MC_NAME_RE = /^[a-zA-Z0-9_]{3,16}$/;

router.get("/results/live", async (_req, res) => {
  const rows = (await db.select().from(tierResultsTable)
    .orderBy(desc(tierResultsTable.createdAt)))
    .filter(row => MC_NAME_RE.test(String(row.username ?? "").trim()))
    .slice(0, 30);
  res.setHeader("Cache-Control", "no-store");
  return res.json({ results: rows });
});

router.get("/results/high-tier", async (_req, res) => {
  const rows = (await db.select().from(tierResultsTable)
    .where(eq(tierResultsTable.isHighTier, true))
    .orderBy(desc(tierResultsTable.createdAt)))
    .filter(row => MC_NAME_RE.test(String(row.username ?? "").trim()))
    .slice(0, 30);
  res.setHeader("Cache-Control", "no-store");
  return res.json({ results: rows });
});

export default router;
