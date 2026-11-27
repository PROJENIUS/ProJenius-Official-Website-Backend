import { Router } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { authenticateAdmin } from "../../middleware/authenticateAdmin.js";
import { csrfProtection } from "../../middleware/csrfProtection.js";
import { requireAnyPermission, requirePermission } from "../admin/management/permissions.js";
import { PAGE_HERO_IMAGE_RULES } from "./pageHero.schemas.js";
import { adminPageHeroMedia, getAdminPageHero, getPublicPageHero, listAdminPageHeroes, resetAdminPageHero, saveAdminPageHero, uploadPageHeroImage } from "./pageHero.controller.js";

const router = Router();
const writeLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many changes. Please wait a few minutes." } });
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: PAGE_HERO_IMAGE_RULES.maxBytes } }).single("image");
const view = requireAnyPermission("pages:heroes:view", "pages:heroes:edit");
const edit = requirePermission("pages:heroes:edit");

function receiveImage(req, res, next) {
  upload(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Select an image up to 5 MB." : "Send one image file." });
    return next(error);
  });
}

router.use("/admin", authenticateAdmin);
router.get("/admin", view, listAdminPageHeroes);
router.get("/admin/media/:mediaId", view, adminPageHeroMedia);
router.get("/admin/:key", view, getAdminPageHero);
router.put("/admin/:key", writeLimit, csrfProtection, edit, saveAdminPageHero);
router.delete("/admin/:key", writeLimit, csrfProtection, edit, resetAdminPageHero);
router.post("/admin/:key/image", writeLimit, csrfProtection, edit, receiveImage, uploadPageHeroImage);
router.get("/:key", getPublicPageHero);

export default router;
