/* =========================================================
   PROJENIUS BACKEND — DATABASE KEEP-ALIVE
   The free MongoDB Atlas tier pauses a cluster that sees no
   activity. Every KEEPALIVE_DAYS (default 15) we write one small
   "ProJenius" entry to its own collection, so real data
   (enquiries, dashboard, emails) is never touched.
========================================================= */

import mongoose from "mongoose";

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS_OF_HISTORY = 180;

const keepAliveSchema = new mongoose.Schema({
  name: { type: String, default: "ProJenius" },
  type: { type: String, default: "database-keepalive" },
  message: { type: String, default: "Automatic keep-alive entry so the free MongoDB cluster stays active. Safe to ignore." },
  source: { type: String, enum: ["scheduler", "endpoint", "script"], required: true },
}, { timestamps: true, strict: "throw" });
keepAliveSchema.index({ createdAt: -1 });

export const KeepAlive = mongoose.models.KeepAlive || mongoose.model("KeepAlive", keepAliveSchema, "system_keepalive");

export const keepAliveIntervalDays = () => {
  const n = Number.parseInt(process.env.KEEPALIVE_DAYS || "", 10);
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : 15;
};

export async function lastKeepAlive() {
  return KeepAlive.findOne().sort({ createdAt: -1 }).lean();
}

/* Writes an entry when the last one is older than `minGapMs` (or always with force). */
export async function runKeepAlive({ source, force = false, minGapMs = keepAliveIntervalDays() * DAY_MS, now = new Date() } = {}) {
  const last = await lastKeepAlive();
  if (!force && last && now - new Date(last.createdAt) < minGapMs) {
    return { written: false, last };
  }
  const entry = await KeepAlive.create({ source });
  // Keep the collection tiny.
  await KeepAlive.deleteMany({ createdAt: { $lt: new Date(now.getTime() - KEEP_DAYS_OF_HISTORY * DAY_MS) } });
  return { written: true, last: entry.toObject() };
}

let timer;
/* Checks once a day while the server is awake; writes when 15 days have passed. */
export function startKeepAliveScheduler() {
  if (timer || process.env.NODE_ENV === "test" || process.env.KEEPALIVE_DISABLED === "1") return;
  const tick = () => runKeepAlive({ source: "scheduler" })
    .then((r) => { if (r.written) console.log("Database keep-alive entry written."); })
    .catch(() => console.error("Database keep-alive failed."));
  void tick();
  timer = setInterval(tick, DAY_MS);
  timer.unref?.();
}

export function stopKeepAliveScheduler() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
