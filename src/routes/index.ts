import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import playersRouter from "./players.js";
import resultsRouter from "./results.js";
import webhookRouter from "./webhook.js";
import presenceRouter from "./presence.js";
import adminRouter from "./admin.js";
import migrateRouter from "./migrate.js";

const router: IRouter = Router();
router.use(healthRouter);
router.use(playersRouter);
router.use(resultsRouter);
router.use(webhookRouter);
router.use(presenceRouter);
router.use(adminRouter);
router.use(migrateRouter);

export default router;
