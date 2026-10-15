
/* =========================================================
   PROJENIUS BACKEND — CSRF PROTECTION
   Responsibility: Protect cookie-authenticated mutations
========================================================= */

import {
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// SECTION: CREATE OR REUSE SESSION TOKEN
export function issueCsrfToken(req, res, next) {
  if (!req.session) {
    return res.status(500).json({
      error: "Session service unavailable.",
    });
  }

  if (!req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString("hex");
  }

  res.json({ csrfToken: req.session.csrfToken });
}

// SECTION: VERIFY CSRF TOKEN
export function csrfProtection(req, res, next) {
  const origin = req.get("origin");
  const allowedOrigin = process.env.ADMIN_SITE_ORIGIN?.replace(/\/+$/, "");
  const normalizedOrigin = origin?.replace(/\/+$/, "");

  function logAuthDiagnostic(details) {
    if (process.env.AUTH_DIAGNOSTICS === "1") {
      console.warn("Admin authentication diagnostic", {
        event: "csrf_rejected",
        method: req.method,
        path: req.path,
        ...details,
      });
    }
  }

  // Browser mutations must originate from the configured admin UI.
  if (!normalizedOrigin || normalizedOrigin !== allowedOrigin) {
    logAuthDiagnostic({
      reason: "origin_missing_or_not_allowed",
      hasOrigin: Boolean(origin),
      configuredAdminOriginPresent: Boolean(allowedOrigin),
    });
    return res.status(403).json({
      error: "Request origin not allowed.",
    });
  }

  const supplied = req.get("x-csrf-token");
  const expected = req.session?.csrfToken;

  if (
    typeof supplied !== "string" ||
    typeof expected !== "string" ||
    !/^[a-f0-9]{64}$/.test(supplied) ||
    !/^[a-f0-9]{64}$/.test(expected)
  ) {
    logAuthDiagnostic({
      reason: "csrf_token_missing_or_malformed",
      suppliedTokenPresent: typeof supplied === "string",
      suppliedTokenWellFormed: typeof supplied === "string" && /^[a-f0-9]{64}$/.test(supplied),
      sessionTokenPresent: typeof expected === "string",
      sessionTokenWellFormed: typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected),
    });
    return res.status(403).json({
      error: "Invalid security token.",
    });
  }

  const suppliedBuffer = Buffer.from(supplied, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  if (!timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    logAuthDiagnostic({
      reason: "csrf_token_mismatch",
      suppliedTokenWellFormed: true,
      sessionTokenWellFormed: true,
    });
    return res.status(403).json({
      error: "Invalid security token.",
    });
  }

  next();
}
