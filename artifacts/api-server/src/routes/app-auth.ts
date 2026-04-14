/**
 * Global app password authentication routes.
 *
 * POST   /api/auth/app/login   — validate shared password, set session
 * POST   /api/auth/app/logout  — destroy session
 * GET    /api/auth/app/me      — return { authenticated: true } or 401
 *
 * NOTE: paths here are relative to the /api mount-point (i.e. no /api prefix).
 */

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";

const router: IRouter = Router();

const loginLimiter = rateLimit({
  windowMs:               15 * 60 * 1000, // 15-minute window
  max:                    10,              // 10 attempts per window per IP
  standardHeaders:        true,
  legacyHeaders:          false,
  skipSuccessfulRequests: true,            // only failed attempts count
  message: { error: "Too many login attempts. Please try again later." },
});

router.post("/auth/app/login", loginLimiter, (req: Request, res: Response): void => {
  const { password } = req.body ?? {};

  const expected = process.env["APP_ACCESS_PASSWORD"];
  if (!expected) {
    res.status(500).json({ error: "Server misconfiguration" });
    return;
  }

  if (typeof password !== "string" || password !== expected) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }

  (req.session as any).appAuthenticated = true;
  req.session.save((err) => {
    if (err) {
      res.status(500).json({ error: "Session error" });
      return;
    }
    res.json({ authenticated: true });
  });
});

router.post("/auth/app/logout", (req: Request, res: Response): void => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: "Logout failed" });
      return;
    }
    res.clearCookie("zeit.sid");
    res.json({ authenticated: false });
  });
});

router.get("/auth/app/me", (req: Request, res: Response): void => {
  if ((req.session as any)?.appAuthenticated) {
    res.json({ authenticated: true });
  } else {
    res.status(401).json({ authenticated: false });
  }
});

// ─── Auth Guard Middleware ──────────────────────────────────────────────────
//
// Applied to the /api router. req.path is relative (no /api prefix).
//
// Public (no session required):
//   /health
//   /auth/app/login
//   /auth/app/logout
//   /auth/app/me
//   /auth/employee/*   (employee PIN — has own auth)

const PUBLIC_EXACT = new Set([
  "/health",
  "/auth/app/login",
  "/auth/app/logout",
  "/auth/app/me",
]);

export function requireAppAuth(req: Request, res: Response, next: NextFunction): void {
  const path = req.path;

  if (PUBLIC_EXACT.has(path) || path.startsWith("/auth/employee/")) {
    next();
    return;
  }

  if ((req.session as any)?.appAuthenticated) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}

export default router;
