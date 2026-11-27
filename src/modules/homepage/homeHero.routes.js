import { Router } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { authenticateAdmin } from "../../middleware/authenticateAdmin.js";
import { csrfProtection } from "../../middleware/csrfProtection.js";
import { requireAnyPermission, requirePermission } from "../admin/management/permissions.js";
import { HERO_RULES } from "./homeHero.rules.js";
import { adminHeroMedia, getAdminHero, getPublicHero, saveAdminHero, uploadHeroImage } from "./homeHero.controller.js";

const router = Router();
const writeLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many changes. Please wait a few minutes." } });
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: HERO_RULES.image.maxBytes } }).single("image");

/* A too-large file is a clear message, not a server error. */
function receiveImage(req, res, next) {
  upload(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Select an image up to 5 MB." : "Send one image file." });
    return next(error);
  });
}

router.get("/hero", getPublicHero);

router.use("/admin", authenticateAdmin);
router.get("/admin/hero", requireAnyPermission("home:hero:view", "home:hero:edit"), getAdminHero);
router.get("/admin/hero/media/:mediaId", requireAnyPermission("home:hero:view", "home:hero:edit"), adminHeroMedia);
router.put("/admin/hero", writeLimit, csrfProtection, requirePermission("home:hero:edit"), saveAdminHero);
router.post("/admin/hero/image", writeLimit, csrfProtection, requirePermission("home:hero:edit"), receiveImage, uploadHeroImage);

export default router;
