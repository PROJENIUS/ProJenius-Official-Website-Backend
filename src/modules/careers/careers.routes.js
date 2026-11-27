import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateAdmin } from "../../middleware/authenticateAdmin.js";
import { csrfProtection } from "../../middleware/csrfProtection.js";
import { requireAnyPermission, requirePermission } from "../admin/management/permissions.js";
import { createOpening, deleteOpening, getPublicOpening, listAdminOpenings, listPublicOpenings, updateOpening } from "./jobOpening.controller.js";

const router = Router();
const writeLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many changes. Please wait a few minutes." } });
const edit = requirePermission("careers:openings:edit");

router.get("/openings", listPublicOpenings);
router.get("/openings/:slug", getPublicOpening);

router.use("/admin", authenticateAdmin);
router.get("/admin/openings", requireAnyPermission("careers:openings:view", "careers:openings:edit"), listAdminOpenings);
router.post("/admin/openings", writeLimit, csrfProtection, edit, createOpening);
router.put("/admin/openings/:id", writeLimit, csrfProtection, edit, updateOpening);
router.delete("/admin/openings/:id", writeLimit, csrfProtection, edit, deleteOpening);

export default router;
