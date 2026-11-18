import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateAdmin } from "../../middleware/authenticateAdmin.js";
import { csrfProtection } from "../../middleware/csrfProtection.js";
import { requirePermission } from "../admin/management/permissions.js";
import {
  getAdminLegalDocument,
  getPublicLegalDocument,
  saveAdminLegalDocument,
} from "./legalDocuments.controller.js";

const router = Router();
const legalWriteLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

router.get(
  "/admin/:key",
  authenticateAdmin,
  requirePermission("legal:documents:view"),
  getAdminLegalDocument,
);
router.put(
  "/admin/:key",
  authenticateAdmin,
  requirePermission("legal:documents:edit"),
  legalWriteLimit,
  csrfProtection,
  saveAdminLegalDocument,
);
router.get("/:key", getPublicLegalDocument);

export default router;
