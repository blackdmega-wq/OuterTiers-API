import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const app: Express = express();
app.use(pinoHttp({ logger, serializers: { req: r => ({ id: r.id, method: r.method, url: r.url?.split("?")[0] }), res: r => ({ statusCode: r.statusCode }) } }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api", router);

export default app;
