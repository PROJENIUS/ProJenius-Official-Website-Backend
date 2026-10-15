/*
 * =========================================================
 * PROJENIUS — ADMIN CONTACT ROUTES
 * Responsibility: Protected enquiry and application APIs
 * =========================================================
 */

import { Router } from "express";

import {
  listEnquiries,
  getEnquiry,
  updateEnquiryStatus,
  downloadEnquiryAttachment,
  listJobApplications,
  getJobApplication,
  updateJobApplicationStatus,
  downloadJobApplicationResume,
  downloadEnquiryReceipt,
  downloadJobApplicationReceipt,
  getDashboardStats,
} from "./adminContact.controller.js";

import { authenticateAdmin } from "../../middleware/authenticateAdmin.js";
import { csrfProtection } from "../../middleware/csrfProtection.js";
import { requirePermission } from "../admin/management/permissions.js";

const router = Router();

// All routes below require an authenticated admin.
router.use(authenticateAdmin);

router.get("/dashboard/stats", requirePermission("dashboard:view"), getDashboardStats);

// ENQUIRIES
router.get("/enquiries", requirePermission("enquiries:list"), listEnquiries);
router.get("/enquiries/:id/receipt", requirePermission("enquiries:download"), downloadEnquiryReceipt);

router.get(
  "/enquiries/:id/attachment",
  requirePermission("enquiries:download"),
  downloadEnquiryAttachment
);

router.get("/enquiries/:id", requirePermission("enquiries:details"), getEnquiry);

router.patch(
  "/enquiries/:id/status",
  requirePermission("enquiries:changeStatus"),
  csrfProtection,
  updateEnquiryStatus
);

// JOB APPLICATIONS
router.get("/job-applications", requirePermission("careerApplications:list"), listJobApplications);
router.get("/job-applications/:id/receipt", requirePermission("careerApplications:download"), downloadJobApplicationReceipt);

router.get(
  "/job-applications/:id/resume",
  requirePermission("careerApplications:download"),
  downloadJobApplicationResume
);

router.get("/job-applications/:id", requirePermission("careerApplications:details"), getJobApplication);

router.patch(
  "/job-applications/:id/status",
  requirePermission("careerApplications:changeStatus"),
  csrfProtection,
  updateJobApplicationStatus
);

export default router;
