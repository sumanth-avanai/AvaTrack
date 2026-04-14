import express, { type Express } from "express";
import cors from "cors";
import session from "express-session";
import pinoHttp from "pino-http";
import "./lib/session"; // apply express-session SessionData augmentation
import router from "./routes";
import { requireAppAuth } from "./routes/app-auth";
import { logger } from "./lib/logger";

// ── Startup validation ────────────────────────────────────────────────────────

if (!process.env["APP_ACCESS_PASSWORD"]) {
  logger.fatal("APP_ACCESS_PASSWORD environment variable is not set. Set it before starting the server.");
  process.exit(1);
}

if (!process.env["SESSION_SECRET"]) {
  logger.fatal("SESSION_SECRET environment variable is not set. Set it before starting the server.");
  process.exit(1);
}

// ── App setup ─────────────────────────────────────────────────────────────────

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(cors({
  origin: true,
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Session middleware ────────────────────────────────────────────────────────

app.use(
  session({
    name:   "zeit.sid",
    secret: process.env["SESSION_SECRET"]!,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure:   process.env["NODE_ENV"] === "production",
      sameSite: "lax",
      maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// ── API routes (guard applied before router) ──────────────────────────────────

app.use("/api", requireAppAuth, router);

export default app;
