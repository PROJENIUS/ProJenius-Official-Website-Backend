
/* =========================================================
   PROJENIUS BACKEND — AUTH ROUTES
   Responsibility: Register admin authentication endpoints
========================================================= */

import { Router } from "express";
import rateLimit from "express-rate-limit";

import {
  getCsrfToken,
  getCurrentAdmin,
  loginAdmin,
  logoutAdmin,
  inviteAdmin,
  acceptAdminInvitation,
  requestPasswordReset,
  resetAdminPassword,
} from "./auth.controller.js";

import { authenticateAdmin } from "../../../middleware/authenticateAdmin.js";
import { csrfProtection } from "../../../middleware/csrfProtection.js";

const router = Router();

// SECTION: LOGIN RATE LIMIT
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Too many login attempts. Please try again later.",
  },
});

const invitationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many invitation attempts. Please try again later." },
});

const recoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many account recovery attempts. Please try again later." },
});

// SECTION: ISSUE CSRF TOKEN
router.get("/csrf", getCsrfToken);

// SECTION: ADMIN LOGIN
router.post("/login", loginLimiter, csrfProtection, loginAdmin);
router.post("/invitations/accept", invitationLimiter, csrfProtection, acceptAdminInvitation);
router.post("/password/forgot", recoveryLimiter, csrfProtection, requestPasswordReset);
router.post("/password/reset", recoveryLimiter, csrfProtection, resetAdminPassword);

// SECTION: CURRENT ADMIN SESSION
router.get("/me", authenticateAdmin, getCurrentAdmin);

// SECTION: ADMIN LOGOUT
router.post(
  "/logout",
  authenticateAdmin,
  csrfProtection,
  logoutAdmin
);

router.post("/invitations", authenticateAdmin, csrfProtection, inviteAdmin);

export default router;
