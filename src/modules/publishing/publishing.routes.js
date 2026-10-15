import { Router } from "express";
import express from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { authenticateAdmin } from "../../middleware/authenticateAdmin.js";
import { csrfProtection } from "../../middleware/csrfProtection.js";
import { requireAnyPermission, requirePermission, requireSuperAdmin } from "../admin/management/permissions.js";
import { subscribe, confirm, unsubscribe, publicList, publicUnifiedList, publicCategories, publicDetail, uploadImage, publicAsset, publicMedia, adminAsset, adminList, adminGet, createArticle, updateArticle, publishNow, changeArticleState, announceAgain, adminStats, adminSubscribers, adminRemoveSubscriber, adminCampaigns, adminDeliveries, retryCampaign, cancelCampaign } from "./publishing.controller.js";

const router = Router();
const limiter = (limit) => rateLimit({ windowMs: 15 * 60 * 1000, limit, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many requests. Please try again later." } });
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: 5 * 1024 * 1024 } }).single("image");

router.post("/newsletter/subscribe", limiter(5), subscribe);
router.post("/newsletter/confirm", limiter(20), confirm);
router.post("/newsletter/unsubscribe", limiter(20), express.urlencoded({ extended: false, limit: "2kb" }), unsubscribe);
router.get("/news/assets/:filename", publicAsset);
router.get("/media/:mediaId", publicMedia);
router.get("/news", publicUnifiedList);
router.get("/news/categories", publicCategories);
router.get("/news/:type", publicList);
router.get("/news/:type/:slug", publicDetail);

router.use("/admin", authenticateAdmin);
router.get("/admin/assets/:filename", requireAnyPermission("publishing:articles:view", "publishing:articles:edit", "publishing:articles:create", "publishing:articles:uploadImage"), adminAsset);
router.get("/admin/articles", requirePermission("publishing:articles:list"), adminList);
router.get("/admin/articles/:id", requireAnyPermission("publishing:articles:view", "publishing:articles:edit"), adminGet);
router.post("/admin/articles", csrfProtection, requirePermission("publishing:articles:create"), (req, res, next) => {
  if (req.body?.status === "published") return requirePermission("publishing:articles:publish")(req, res, next);
  if (req.body?.status === "scheduled") return requirePermission("publishing:articles:schedule")(req, res, next);
  return next();
}, createArticle);
router.patch("/admin/articles/:id", csrfProtection, requirePermission("publishing:articles:edit"), updateArticle);
router.post("/admin/articles/:id/publish", csrfProtection, requirePermission("publishing:articles:publish"), publishNow);
router.patch("/admin/articles/:id/state", csrfProtection, (req, res, next) => { const permission = { schedule: "publishing:articles:schedule", unpublish: "publishing:articles:publish", archive: "publishing:articles:archive" }[req.body?.action]; if (!permission) return res.status(400).json({ error: "Article action is invalid." }); return requirePermission(permission)(req, res, next); }, changeArticleState);
router.post("/admin/articles/:id/announce", csrfProtection, requirePermission("publishing:campaigns:create"), announceAgain);
router.post("/admin/articles/image", csrfProtection, requirePermission("publishing:articles:uploadImage"), upload, uploadImage);
router.get("/admin/newsletter/stats", requirePermission("newsletter:subscribers:view"), adminStats);
router.get("/admin/newsletter/subscribers", requirePermission("newsletter:subscribers:view"), adminSubscribers);
router.delete("/admin/newsletter/subscribers/:id", csrfProtection, requireSuperAdmin, adminRemoveSubscriber);
router.get("/admin/newsletter/campaigns", requirePermission("newsletter:campaigns:view"), adminCampaigns);
router.get("/admin/newsletter/campaigns/:id/deliveries", requirePermission("newsletter:campaigns:view"), adminDeliveries);
router.post("/admin/newsletter/campaigns/:id/retry", csrfProtection, requirePermission("newsletter:campaigns:retry"), retryCampaign);
router.post("/admin/newsletter/campaigns/:id/cancel", csrfProtection, requirePermission("newsletter:campaigns:cancel"), cancelCampaign);

export default router;
