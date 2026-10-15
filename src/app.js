/*
 * =========================================================
 * PROJENIUS BACKEND — EXPRESS APPLICATION
 * Responsibility: Security, sessions and API registration
 * =========================================================
 */

import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import session from "express-session";
import MongoStore from "connect-mongo";
import multer from "multer";
import mongoose from "mongoose";
import { DATABASE_NAME } from "./config/database.js";
import { razorpayWebhook } from "./modules/courses/courses.controller.js";

import { registerApiRoutes } from "./routes/index.js";

const app = express();

// SECTION: TRUST PROXY
if (process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

// SECTION: SECURITY HEADERS
app.disable("x-powered-by");
app.use(helmet());

// SECTION: ENVIRONMENT VALIDATION
const isProduction = process.env.NODE_ENV === "production";

if (!process.env.ADMIN_SITE_ORIGIN) {
  throw new Error("ADMIN_SITE_ORIGIN is not configured.");
}

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is not configured.");
}

if (
  !process.env.SESSION_SECRET ||
  Buffer.byteLength(process.env.SESSION_SECRET, "utf8") < 32
) {
  throw new Error(
    "SESSION_SECRET must be configured with at least 32 bytes."
  );
}

// SECTION: CORS CONFIGURATION
const allowedOrigins = [
  process.env.ADMIN_SITE_ORIGIN,
  process.env.PUBLIC_SITE_ORIGIN,
]
  .filter(Boolean)
  .map((origin) => origin.replace(/\/+$/, ""));

app.use(
  cors({
    origin(origin, callback) {
      // Requests without an Origin header (such as server-to-server
      // requests) are allowed, but receive no CORS permission header.
      if (!origin) {
        return callback(null, false);
      }

      const normalizedOrigin = origin.replace(/\/+$/, "");

      if (allowedOrigins.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      if (process.env.AUTH_DIAGNOSTICS === "1") {
        console.warn("Admin authentication diagnostic", {
          event: "cors_rejected",
          reason: "origin_not_allowlisted",
          hasOrigin: true,
          adminOriginMatch: normalizedOrigin === allowedOrigins[0],
          publicOriginMatch: normalizedOrigin === allowedOrigins[1],
        });
      }

      return callback(new Error("Origin not allowed"));
    },

    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token", "Idempotency-Key"],
    maxAge: 600,
  })
);

// Razorpay signs the exact request bytes. Keep this endpoint ahead of the
// JSON parser so signature verification uses the untouched raw body.
app.post(
  "/api/courses/payments/webhook",
  rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }),
  express.raw({ type: "application/json", limit: "256kb" }),
  razorpayWebhook
);

// SECTION: REQUEST BODY LIMIT
app.use(express.json({ limit: "100kb" }));

// SECTION: GENERAL API RATE LIMIT
app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: "Too many requests. Please try again later.",
    },
  })
);

// SECTION: SESSION CONFIGURATION
const sessionStore = process.env.NODE_ENV === "test"
  ? new session.MemoryStore()
  : MongoStore.create({
      mongoUrl: process.env.MONGODB_URI,
      dbName: DATABASE_NAME,
      collectionName: "sessions",
      ttl: 7 * 24 * 60 * 60,
      autoRemove: "native",
    });

app.use(
  session({
    name: isProduction ? "__Host-pj.sid" : "pj.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,

    store: sessionStore,

    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 1000,
    },
  })
);

export async function initializeSessionStore() {
  if (sessionStore.collectionP) await sessionStore.collectionP;
}

export async function closeSessionStore() {
  if (typeof sessionStore.close === "function") await sessionStore.close();
}

// SECTION: HEALTH CHECK
app.get("/api/health", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    if (!mongoose.connection.db) throw new Error("Database is not connected.");
    await mongoose.connection.db.admin().ping();
    return res.status(200).json({ status: "ok", database: "available" });
  } catch {
    return res.status(503).json({ status: "unavailable" });
  }
});

// SECTION: API ROUTE GROUPS
registerApiRoutes(app);

// SECTION: NOT FOUND
app.use((_req, res) => {
  return res.status(404).json({
    error: "Resource not found.",
  });
});

// SECTION: CENTRAL ERROR HANDLER
app.use((error, _req, res, _next) => {
  if (res.headersSent) {
    return;
  }

  if (process.env.NODE_ENV !== "production") {
    console.error("API request failed.");
  }

  if (error.message === "Origin not allowed") {
    return res.status(403).json({
      error: "Request origin not allowed.",
    });
  }

  if (error instanceof multer.MulterError) {
    const isTooLarge = error.code === "LIMIT_FILE_SIZE";

    return res.status(isTooLarge ? 413 : 400).json({
      error: isTooLarge
        ? "The uploaded file must not exceed 5 MB."
        : "The uploaded file or form submission is invalid.",
    });
  }

  if (error.status === 400 || error.status === 413) {
    return res.status(error.status).json({
      error: error.message,
    });
  }

  return res.status(500).json({
    error: "An unexpected server error occurred.",
  });
});

export default app;
