import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import playersRouter from "./players.js";
import resultsRouter from "./results.js";
import webhookRouter from "./webhook.js";

const router: IRouter = Router();
router.use(healthRouter);
router.use(playersRouter);
router.use(resultsRouter);
router.use(webhookRouter);

export default router;
