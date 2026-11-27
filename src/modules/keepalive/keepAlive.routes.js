import crypto from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { lastKeepAlive, runKeepAlive } from "./keepAlive.service.js";

/* GET /api/keepalive?token=…  (or header X-Keepalive-Token)
   For a free outside cron service (e.g. cron-job.org) so the
   database stays active even while the server host is asleep.
   Writes at most one entry per 12 hours, whatever the call rate. */

const router = Router();
const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 12, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many keep-alive calls." } });

function tokenMatches(given) {
  const expected = process.env.KEEPALIVE_TOKEN?.trim();
  if (!expected || expected.length < 24 || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.get("/", limiter, async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    if (!process.env.KEEPALIVE_TOKEN?.trim()) return res.status(503).json({ error: "Keep-alive is not configured." });
    if (!tokenMatches(req.get("X-Keepalive-Token") || req.query.token)) return res.status(401).json({ error: "Invalid keep-alive token." });
    const result = await runKeepAlive({ source: "endpoint", minGapMs: 12 * 60 * 60 * 1000 });
    const last = result.last || await lastKeepAlive();
    return res.json({ ok: true, written: result.written, lastEntryAt: last?.createdAt || null });
  } catch (error) { return next(error); }
});

export default router;
