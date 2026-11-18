import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateAdmin } from "../../middleware/authenticateAdmin.js";
import { csrfProtection } from "../../middleware/csrfProtection.js";
import { requirePermission } from "../admin/management/permissions.js";
import {
  adminGetGuidanceSettings, adminGuidanceReceipt, adminListGuidanceBookings, adminRefundGuidance, adminRetryGuidanceEmails,
  adminSaveGuidanceSettings, adminUpdateGuidanceStatus, createGuidanceOrder, downloadGuidanceReceipt, publicGuidanceConfig,
  recordGuidanceFailure, verifyGuidancePayment,
} from "./guidance.controller.js";

const router = Router();
const checkoutLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many booking attempts. Try again later." } });

// Public (website)
router.get("/config", publicGuidanceConfig);
router.post("/orders", checkoutLimit, createGuidanceOrder);
router.post("/payments/verify", checkoutLimit, verifyGuidancePayment);
router.post("/payments/failure", checkoutLimit, recordGuidanceFailure);
router.get("/receipt/:token", downloadGuidanceReceipt);

// Admin
router.use("/admin", authenticateAdmin);
router.get("/admin/settings", requirePermission("guidance:view"), adminGetGuidanceSettings);
router.put("/admin/settings", requirePermission("guidance:settings"), csrfProtection, adminSaveGuidanceSettings);
router.get("/admin/bookings", requirePermission("guidance:view"), adminListGuidanceBookings);
router.get("/admin/bookings/:id/receipt", requirePermission("guidance:view"), adminGuidanceReceipt);
router.patch("/admin/bookings/:id/status", requirePermission("guidance:manage"), csrfProtection, adminUpdateGuidanceStatus);
router.post("/admin/bookings/:id/refund", requirePermission("guidance:refund"), csrfProtection, adminRefundGuidance);
router.post("/admin/bookings/:id/emails/retry", requirePermission("guidance:manage"), csrfProtection, adminRetryGuidanceEmails);

export default router;
