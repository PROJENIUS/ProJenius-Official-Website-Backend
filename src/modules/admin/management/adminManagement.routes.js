import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateAdmin } from "../../../middleware/authenticateAdmin.js";
import { csrfProtection } from "../../../middleware/csrfProtection.js";
import {
  getAdministrator,
  listAdministrators,
  listAdminAuditEvents,
  listPendingInvitations,
  removeAdministrator,
  resendInvitation,
  setAdministratorActive,
  triggerPasswordReset,
  updateAdministratorPermissions,
} from "./adminManagement.controller.js";
import { requireSuperAdmin } from "./permissions.js";

const router = Router();
const sensitiveActionLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many administrator security actions. Try again later." },
});

router.use(authenticateAdmin, requireSuperAdmin);
router.get("/", listAdministrators);
router.get("/invitations", listPendingInvitations);
router.post("/invitations/:id/resend", sensitiveActionLimit, csrfProtection, resendInvitation);
router.get("/audit-logs", listAdminAuditEvents);
router.get("/:id", getAdministrator);
router.patch("/:id/permissions", csrfProtection, updateAdministratorPermissions);
router.patch("/:id/status", sensitiveActionLimit, csrfProtection, setAdministratorActive);
router.post("/:id/password-reset", sensitiveActionLimit, csrfProtection, triggerPasswordReset);
router.delete("/:id", sensitiveActionLimit, csrfProtection, removeAdministrator);

export default router;
