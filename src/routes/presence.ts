import { Router, type IRouter, type Request, type Response } from "express";

/**
 * In-memory presence tracker. Each client posts a heartbeat every ~20s with
 * an anonymous id; entries older than ONLINE_WINDOW_MS are considered offline.
 *
 * This is intentionally tiny — no DB writes, no auth, no PII. The id is just
 * an opaque string the client generated locally.
 */
const ONLINE_WINDOW_MS = 45_000; // 45s grace
const MAX_ENTRIES = 50_000;
const lastSeen = new Map<string, number>();

function pruneAndCount(): number {
  const cutoff = Date.now() - ONLINE_WINDOW_MS;
  for (const [id, ts] of lastSeen) {
    if (ts < cutoff) lastSeen.delete(id);
  }
  return lastSeen.size;
}

const router: IRouter = Router();

router.post("/presence", (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { id?: unknown };
  let id = typeof body.id === "string" ? body.id.slice(0, 64) : "";
  if (!id) id = `anon-${Math.random().toString(36).slice(2, 10)}`;

  // Soft cap to prevent unbounded growth from abuse.
  if (lastSeen.size > MAX_ENTRIES) pruneAndCount();
  if (lastSeen.size > MAX_ENTRIES) {
    return res.status(503).json({ error: "presence at capacity" });
  }

  lastSeen.set(id, Date.now());
  const online = pruneAndCount();
  res.setHeader("Cache-Control", "no-store");
  res.json({ online });
});

router.get("/presence", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ online: pruneAndCount() });
});

export default router;
