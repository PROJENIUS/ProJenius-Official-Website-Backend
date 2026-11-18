import { Router } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { authenticateAdmin } from "../../middleware/authenticateAdmin.js";
import { csrfProtection } from "../../middleware/csrfProtection.js";
import { requireAnyPermission, requirePermission } from "../admin/management/permissions.js";
import { adminGetCoursePolicy, adminListCourseCommonFaqs, deleteCourseCommonFaq, listCourseCommonFaqs, publishCoursePolicy, publicCoursePolicy, saveCourseCommonFaq, saveCoursePolicyDraft } from "./courseContent.controller.js";
import {
  adminCourseImage, adminGetCourse, adminListCourses, listCourseScheduleHistory, changeCourseState, courseAnalytics, createCourse,
  createPaymentOrder, exportCourseReport, listCourseEnrollments, listCoursePayments, recordPaymentFailure,
  listCourseRefunds, downloadCourseReceipt, publicCourseAsset, publicCourseDetail, publicListCourses,
  updateCourse, uploadCourseImage, verifyCheckoutPayment, getCourseEnrollment,
  retryCoursePaymentNotifications,
  listCourseNotifications, retryCourseNotification,
  downloadPublicCourseReceipt, requestCourseReceiptLink,
} from "./courses.controller.js";
import { adminDashboard, clearDashboardNotifications } from "./courseDashboard.controller.js";

const router = Router();
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single("image");
const checkoutLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many checkout attempts. Try again later." } });
const receiptLinkLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many receipt-link requests. Try again later." } });
export const courseUpdatePermission = (body = {}) => ["batches", "startDate", "registrationDeadline", "timezone", "deliveryMode", "deliveryDetails", "enrollmentOpen", "sessionLength", "sessionCount", "courseValidity"].some((field) => Object.hasOwn(body, field)) ? "courses:schedule" : "courses:edit";
export const courseCreatePermission = (body = {}) => ["batches", "startDate", "registrationDeadline", "timezone", "deliveryDetails", "enrollmentOpen", "sessionLength", "sessionCount", "courseValidity"].some((field) => Object.hasOwn(body, field)) ? "courses:schedule" : "courses:create";

router.get("/", publicListCourses);
router.get("/terms", publicCoursePolicy);
router.get("/faqs", listCourseCommonFaqs);
router.get("/assets/:filename", publicCourseAsset);
router.get("/slug/:slug", publicCourseDetail);
router.post("/:courseId/orders", checkoutLimit, createPaymentOrder);
router.post("/payments/verify", checkoutLimit, verifyCheckoutPayment);
router.post("/payments/failure", checkoutLimit, recordPaymentFailure);
router.get("/receipt/:token", downloadPublicCourseReceipt);
router.post("/receipt-link", receiptLinkLimit, requestCourseReceiptLink);

router.use("/admin", authenticateAdmin);
router.get("/admin/common-faqs", requirePermission("courses:view"), adminListCourseCommonFaqs);
router.post("/admin/common-faqs", requirePermission("courses:edit"), csrfProtection, saveCourseCommonFaq);
router.patch("/admin/common-faqs/:id", requirePermission("courses:edit"), csrfProtection, saveCourseCommonFaq);
router.delete("/admin/common-faqs/:id", requirePermission("courses:edit"), csrfProtection, deleteCourseCommonFaq);
router.get("/admin/policy", requirePermission("courses:view"), adminGetCoursePolicy);
router.put("/admin/policy", requirePermission("courses:edit"), csrfProtection, saveCoursePolicyDraft);
router.post("/admin/policy/publish", requirePermission("courses:publish"), csrfProtection, publishCoursePolicy);
router.get("/admin/courses", requirePermission("courses:list"), adminListCourses);
router.get("/admin/courses/:id", requirePermission("courses:view"), adminGetCourse);
router.get("/admin/courses/:id/image", requireAnyPermission("courses:view", "courses:edit", "courses:uploadImage"), adminCourseImage);
router.get("/admin/courses/:id/schedule-history", requirePermission("courses:view"), listCourseScheduleHistory);
router.post("/admin/courses", requirePermission("courses:create"), csrfProtection, (req, res, next) => requirePermission(courseCreatePermission(req.body))(req, res, next), createCourse);
router.patch("/admin/courses/:id", csrfProtection, (req, res, next) => {
  return requirePermission(courseUpdatePermission(req.body))(req, res, next);
}, updateCourse);
router.post("/admin/courses/:id/image", requirePermission("courses:uploadImage"), csrfProtection, imageUpload, uploadCourseImage);
router.patch("/admin/courses/:id/state", csrfProtection, (req, res, next) => {
  const permission = { publish: "courses:publish", schedule: "courses:schedule", unpublish: "courses:unpublish", archive: "courses:archive" }[req.body?.action];
  if (!permission) return res.status(400).json({ error: "Invalid course action." });
  return requirePermission(permission)(req, res, next);
}, changeCourseState);
router.get("/admin/enrollments", requirePermission("courses:enrollments:view"), listCourseEnrollments);
router.get("/admin/enrollments/:id", requirePermission("courses:enrollments:details"), getCourseEnrollment);
router.post("/admin/enrollments/:id/payment-notifications/retry", requirePermission("courses:notifications:retry"), csrfProtection, retryCoursePaymentNotifications);
router.get("/admin/notifications", requirePermission("courses:notifications:view"), listCourseNotifications);
router.post("/admin/notifications/:id/retry", requirePermission("courses:notifications:retry"), csrfProtection, retryCourseNotification);
router.get("/admin/enrollments/:id/receipt", requirePermission("courses:payments:view"), downloadCourseReceipt);
router.get("/admin/payments", requirePermission("courses:payments:view"), listCoursePayments);
router.get("/admin/dashboard", requirePermission("dashboard:view"), adminDashboard);
router.post("/admin/dashboard/notifications/clear", requirePermission("dashboard:view"), csrfProtection, clearDashboardNotifications);
router.get("/admin/analytics", requirePermission("courses:analytics:view"), courseAnalytics);
router.get("/admin/reports/enrollments.csv", requirePermission("courses:reports:export"), exportCourseReport);
router.get("/admin/refunds", requirePermission("courses:refunds:view"), listCourseRefunds);

export default router;
