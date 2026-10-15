import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import Course from "./course.model.js";
import CourseAudit from "./courseAudit.model.js";
import CourseEnrollment from "./courseEnrollment.model.js";
import CoursePayment from "./coursePayment.model.js";
import CourseRefund from "./courseRefund.model.js";
import CourseWebhookEvent from "./courseWebhookEvent.model.js";
import CourseReceipt from "./courseReceipt.model.js";
import { processVerifiedCourseEnrollment } from "./courseNotifications.service.js";
import { getRazorpayClient, verifyPaymentSignature, verifyWebhookSignature } from "../../shared/payments/razorpay.service.js";
import { getOrCreateCourseReceipt, readCourseReceiptFile } from "./courseReceipt.service.js";
import { enqueueCourseNotification, enqueueDecisionNotification, enqueueScheduleNotifications, listCourseNotificationJobs, processCourseNotificationWorkerOnce, retryCourseNotificationJob, retryCourseNotificationsForEnrollment } from "./courseNotificationQueue.service.js";
import { CourseValidationError, validateCourseInput, validateStudentInput } from "./courses.validation.js";
import { publicAssetUrl } from "../../shared/http/publicAssetUrl.js";
import { streamStoredImage, storeImage } from "../../shared/media/gridfsMedia.service.js";

const TERMS_VERSION = process.env.COURSE_TERMS_VERSION?.trim() || "live-training-v2";
const DEFAULT_TERMS_POLICY = "Please review the programme details, delivery mode, schedule and fees carefully before payment. The registration fee is non-refundable for participant cancellation, non-attendance or a change of personal plans. Batch-change requests are subject to availability and written approval and are not guaranteed. If ProJenius cancels a programme or cannot provide the purchased service, we will address the matter under the applicable cancellation policy and law. Verified duplicate or erroneous charges will be investigated. A registration rejection does not itself mean a refund has been issued; any refund is handled separately and only after review. Payment-provider disputes and any refund required by applicable law will be handled in accordance with applicable requirements. Nothing in these terms removes rights that cannot legally be waived. Your contact details are used to process payment, registration and support. The schedule or venue may change; material updates will be communicated. This policy requires appropriate legal review before production use.";
const TERMS_POLICY = (process.env.COURSE_TERMS_POLICY?.trim() || DEFAULT_TERMS_POLICY).slice(0, 4000);
const PAGE_LIMIT = 100;
const COURSE_TRANSITIONS = Object.freeze({
  publish: ["draft", "scheduled", "unpublished"],
  schedule: ["draft", "scheduled", "unpublished"],
  unpublish: ["published", "scheduled"],
  archive: ["draft", "scheduled", "published", "unpublished"],
});
const PRIVATE_UPLOAD_ROOT = path.resolve(process.env.PRIVATE_UPLOAD_DIR || "./private_uploads");
const ASSET_ROOT = path.join(PRIVATE_UPLOAD_ROOT, "course_images");
const LEGACY_ASSET_ROOT = path.resolve(process.cwd(), "private_uploads", "course_images");
let testGateway;
const idValid = (id) => mongoose.isValidObjectId(id);
const safeInt = (v, fallback) => Math.min(PAGE_LIMIT, Math.max(1, Number.parseInt(v, 10) || fallback));
const asId = (value) => String(value?._id || value);
const payableCourse = (course) => course && course.status === "published" && course.deliveryMode !== "self-paced" && course.publishedAt && course.publishedAt <= new Date() && course.enrollmentOpen && (!course.registrationDeadline || course.registrationDeadline > new Date());
const liveDeliveryFilter = { deliveryMode: { $in: ["online", "in-person", "hybrid"] } };
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function dateRange(query) {
  const range = {};
  if (query.from) { const value = new Date(query.from); if (Number.isNaN(value.getTime())) throw new CourseValidationError("Start date filter is invalid."); range.$gte = value; }
  if (query.to) { const value = new Date(query.to); if (Number.isNaN(value.getTime())) throw new CourseValidationError("End date filter is invalid."); if (/^\d{4}-\d{2}-\d{2}$/.test(query.to)) value.setUTCHours(23, 59, 59, 999); range.$lte = value; }
  if (range.$gte && range.$lte && range.$gte > range.$lte) throw new CourseValidationError("Date range is invalid.");
  return Object.keys(range).length ? range : null;
}
export function detectCourseImageType(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || !Number.isSafeInteger(file.size) || file.size < 12 || file.size > 5 * 1024 * 1024) return null;
  const extension = path.extname(String(file.originalname || "")).toLowerCase();
  const signatures = [
    { mime: "image/png", exts: [".png"], ext: "png", sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { mime: "image/jpeg", exts: [".jpg", ".jpeg"], ext: "jpg", sig: [0xff, 0xd8, 0xff] },
    { mime: "image/webp", exts: [".webp"], ext: "webp", sig: [0x52, 0x49, 0x46, 0x46] },
  ];
  return signatures.find((type) => type.mime === file.mimetype && type.exts.includes(extension) && type.sig.every((byte, index) => file.buffer[index] === byte) && (type.mime !== "image/webp" || file.buffer.toString("ascii", 8, 12) === "WEBP")) || null;
}
export function canTransitionCourse(status, action) { return COURSE_TRANSITIONS[action]?.includes(status) || false; }

async function courseAssetPath(filename) {
  for (const root of [ASSET_ROOT, LEGACY_ASSET_ROOT]) {
    const filepath = path.join(root, filename);
    const stat = await fs.lstat(filepath).catch(() => null);
    if (stat?.isFile() && !stat.isSymbolicLink()) return filepath;
  }
  return null;
}

function razorpay() {
  if (process.env.NODE_ENV === "test" && testGateway) return testGateway;
  return getRazorpayClient();
}
export function setRazorpayRuntimeForTests(runtime) {
  if (process.env.NODE_ENV !== "test") throw new Error("Payment test runtime is only available in test mode.");
  const previous = testGateway;
  testGateway = runtime;
  return () => { testGateway = previous; };
}
function publicCourse(course) {
  const item = course.toObject ? course.toObject() : course;
  delete item.internalCostMinor;
  delete item.deliveryDetails;
  if (item.registrationDeadline && item.registrationDeadline <= new Date()) item.enrollmentOpen = false;
  delete item.batches;
  delete item.startDate;
  delete item.registrationDeadline;
  delete item.timezone;
  delete item.createdBy; delete item.updatedBy; delete item.scheduledBy; delete item.publishedBy;
  if (item.coverImage?.mediaId) item.coverImage.url = publicAssetUrl(`/api/media/${item.coverImage.mediaId}`);
  else if (item.coverImage?.filename) item.coverImage.url = publicAssetUrl(`/api/courses/assets/${encodeURIComponent(item.coverImage.filename)}`);
  return item;
}
async function audit(req, course, action, changes = {}) {
  const redact = (value) => {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== "object" || value instanceof Date) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => ["onlineJoinUrl", "onlineAccessCode", "venueAddress"].includes(key) && entry ? [key, "[private value changed]"] : [key, redact(entry)]));
  };
  await CourseAudit.create({ eventKey: crypto.randomUUID(), courseId: course._id, actorId: req.admin?.id || null, action, changes: redact(changes) });
}
function sendError(error, res, next) {
  if (error instanceof CourseValidationError) return res.status(400).json({ error: error.message });
  return next(error);
}

export async function publicListCourses(req, res, next) {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = safeInt(req.query.limit, 12);
    const filter = { ...liveDeliveryFilter, status: "published", publishedAt: { $lte: new Date() } };
    if (typeof req.query.category === "string" && req.query.category.trim()) filter.category = req.query.category.trim().slice(0, 100);
    const [items, total] = await Promise.all([
      Course.find(filter).select("-internalCostMinor -createdBy -updatedBy -scheduledBy -publishedBy").sort({ publishedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Course.countDocuments(filter),
    ]);
    res.set("Cache-Control", "public, max-age=60");
    return res.json({ items: items.map(publicCourse), pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { return next(error); }
}
export function publicCourseTerms(_req, res) {
  return res.set("Cache-Control", "no-store").json({ item: { version: TERMS_VERSION, policy: TERMS_POLICY } });
}

export async function publicCourseDetail(req, res, next) {
  try {
    const item = await Course.findOne({ ...liveDeliveryFilter, slug: req.params.slug, status: "published", publishedAt: { $lte: new Date() } }).select("-internalCostMinor -createdBy -updatedBy -scheduledBy -publishedBy").lean();
    if (!item) return res.status(404).json({ error: "Course not found." });
    res.set("Cache-Control", "public, max-age=60");
    return res.json({ item: publicCourse(item) });
  } catch (error) { return next(error); }
}

export async function publicCourseAsset(req, res, next) {
  try {
    const filename = req.params.filename;
    const missingImage = () => res.status(404).type("text/plain").send("Course image not found.");
    if (!/^[a-f\d-]{36}\.(?:png|jpe?g|webp)$/i.test(filename)) return missingImage();
    const exists = await Course.exists({ ...liveDeliveryFilter, "coverImage.filename": filename, status: "published", publishedAt: { $lte: new Date() } });
    if (!exists) return missingImage();
    const filepath = await courseAssetPath(filename);
    if (!filepath) return missingImage();
    res.set({ "Cache-Control": "public, max-age=300", "Cross-Origin-Resource-Policy": "cross-origin" });
    return res.sendFile(filepath, (error) => { if (error && !res.headersSent) missingImage(); });
  } catch (error) { return next(error); }
}

export async function adminListCourses(req, res, next) {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1), limit = safeInt(req.query.limit, 20);
    const filter = {};
    if (req.query.status) {
      if (!["draft", "scheduled", "published", "unpublished", "archived"].includes(req.query.status)) return res.status(400).json({ error: "Invalid course status." });
      filter.status = req.query.status;
    } else filter.status = { $ne: "archived" };
    if (req.query.search) {
      if (typeof req.query.search !== "string" || req.query.search.length > 100) return res.status(400).json({ error: "Course search is invalid." });
      const match = new RegExp(escapeRegex(req.query.search.trim()), "i");
      filter.$or = [{ title: match }, { slug: match }, { category: match }];
    }
    const [items, total] = await Promise.all([Course.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), Course.countDocuments(filter)]);
    const canSeePrivate = req.admin.role === "superadmin" || req.admin.permissions?.includes("courses:view");
    const visibleItems = items.map((source) => {
      const item = { ...source };
      if (req.admin.role !== "superadmin" && !req.admin.permissions?.includes("courses:analytics:view")) delete item.internalCostMinor;
      if (!canSeePrivate) {
        delete item.deliveryDetails;
        item.batches = (item.batches || []).map((batch) => ({ ...batch, sessions: (batch.sessions || []).map((session) => {
          const safe = { ...session };
          for (const key of ["onlinePlatform", "onlineJoinUrl", "onlineAccessCode", "venueName", "venueAddress", "reportingTime"]) delete safe[key];
          return safe;
        }) }));
      }
      return item;
    });
    return res.json({ items: visibleItems, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { return next(error); }
}
export async function adminGetCourse(req, res, next) {
  if (!idValid(req.params.id)) return res.status(400).json({ error: "Invalid course ID." });
  try {
    const item = await Course.findById(req.params.id).lean();
    if (!item) return res.status(404).json({ error: "Course not found." });
    if (req.admin.role !== "superadmin" && !req.admin.permissions?.includes("courses:analytics:view")) delete item.internalCostMinor;
    if (req.admin.role !== "superadmin" && !req.admin.permissions?.includes("courses:view")) {
      delete item.deliveryDetails;
      item.batches = (item.batches || []).map((batch) => ({ ...batch, sessions: (batch.sessions || []).map((session) => {
        const safe = { ...session };
        for (const key of ["onlinePlatform", "onlineJoinUrl", "onlineAccessCode", "venueName", "venueAddress", "reportingTime"]) delete safe[key];
        return safe;
      }) }));
    }
    return res.json({ item });
  }
  catch (error) { return next(error); }
}

export async function adminCourseImage(req, res, next) {
  if (!idValid(req.params.id)) return res.sendStatus(404);
  try {
    const course = await Course.findById(req.params.id).select("coverImage").lean();
    if (course?.coverImage?.mediaId) {
      if (!(await streamStoredImage(course.coverImage.mediaId, res, { cacheControl: "private, no-store" }))) return res.sendStatus(404);
      return;
    }
    if (!course?.coverImage?.filename || !/^[a-f\d-]{36}\.(?:png|jpe?g|webp)$/i.test(course.coverImage.filename)) return res.sendStatus(404);
    const filepath = await courseAssetPath(course.coverImage.filename);
    if (!filepath) return res.sendStatus(404);
    res.set("Cache-Control", "private, no-store");
    return res.sendFile(filepath, (error) => { if (error && !res.headersSent) res.sendStatus(404); });
  } catch (error) { return next(error); }
}

export async function listCourseScheduleHistory(req, res, next) {
  if (!idValid(req.params.id)) return res.status(400).json({ error: "Invalid course ID." });
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = { courseId: req.params.id, action: "course.updated", "changes.reason": { $exists: true } };
    const [rows, total] = await Promise.all([
      CourseAudit.find(filter).select("action changes.reason changes.previous.batches changes.next.batches actorId createdAt").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      CourseAudit.countDocuments(filter),
    ]);
    const summary = (batches = []) => batches.map((batch) => ({
      code: batch.code, label: batch.label, status: batch.status, deliveryMode: batch.deliveryMode,
      startsAt: batch.startsAt, endsAt: batch.endsAt, timezone: batch.timezone,
      sessions: (batch.sessions || []).map(({ title, startsAt, endsAt, status }) => ({ title, startsAt, endsAt, status })),
    }));
    return res.json({ items: rows.map((row) => ({ _id: row._id, action: row.action, reason: row.changes?.reason || "", actorId: row.actorId, createdAt: row.createdAt, previous: summary(row.changes?.previous?.batches), next: summary(row.changes?.next?.batches) })), pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { return next(error); }
}
export async function createCourse(req, res, next) {
  try {
    const input = validateCourseInput(req.body);
    if (input.internalCostMinor !== undefined && req.admin.role !== "superadmin" && !req.admin.permissions?.includes("courses:analytics:view")) return res.status(403).json({ error: "Financial analytics permission is required to set internal cost." });
    const item = await Course.create({ ...input, createdBy: req.admin.id, updatedBy: req.admin.id });
    await audit(req, item, "course.created");
    return res.status(201).json({ item });
  } catch (error) { if (error.code === 11000) return res.status(409).json({ error: "A course already uses that slug." }); return sendError(error, res, next); }
}
export async function updateCourse(req, res, next) {
  if (!idValid(req.params.id)) return res.status(400).json({ error: "Invalid course ID." });
  try {
    const item = await Course.findById(req.params.id);
    if (!item) return res.status(404).json({ error: "Course not found." });
    const { scheduleChangeReason, ...courseFields } = req.body || {};
    if (scheduleChangeReason !== undefined && (typeof scheduleChangeReason !== "string" || scheduleChangeReason.length > 500)) return res.status(400).json({ error: "Schedule change reason must be 500 characters or fewer." });
    const changeReason = scheduleChangeReason?.trim() || "The programme schedule was updated.";
    const input = validateCourseInput({ ...courseFields, ...(courseFields.registrationDeadline !== undefined && courseFields.timezone === undefined ? { timezone: item.timezone || "Asia/Kolkata" } : {}) }, { partial: true });
    const effectiveSellingPrice = input.priceMinor ?? item.priceMinor;
    const effectiveListPrice = Object.hasOwn(input, "listPriceMinor") ? input.listPriceMinor : item.listPriceMinor;
    if (effectiveListPrice != null && effectiveListPrice <= effectiveSellingPrice) return res.status(400).json({ error: "List price must be greater than the selling price." });
    if (input.internalCostMinor !== undefined && req.admin.role !== "superadmin" && !req.admin.permissions?.includes("courses:analytics:view")) return res.status(403).json({ error: "Financial analytics permission is required to change internal cost." });
    if (!Object.keys(input).length) return res.status(400).json({ error: "Provide at least one course field to update." });
    if (input.batches) {
      const oldBatches = item.batches.map((batch) => batch.toObject());
      for (const batch of input.batches) {
        const previousBatch = oldBatches.find((old) => (batch._id && String(old._id) === String(batch._id)) || old.code === batch.code);
        if (previousBatch && !batch._id) batch._id = previousBatch._id;
        if (previousBatch) {
          for (const session of batch.sessions) {
            const previousSession = previousBatch.sessions.find((old) => (session._id && String(old._id) === String(session._id)) || (!session._id && old.title === session.title));
            if (previousSession && !session._id) session._id = previousSession._id;
          }
        }
      }
      const referencedBatchIds = new Set((await CourseEnrollment.distinct("batchId", { courseId: item._id, batchId: { $ne: null } })).map(String));
      for (const previousBatch of oldBatches) {
        if (referencedBatchIds.has(String(previousBatch._id)) && !input.batches.some((batch) => String(batch._id || "") === String(previousBatch._id))) {
          return res.status(409).json({ error: "A batch with registrations cannot be removed. Mark it cancelled or completed to preserve its history." });
        }
        if (referencedBatchIds.has(String(previousBatch._id))) {
          const nextBatch = input.batches.find((batch) => String(batch._id || "") === String(previousBatch._id));
          const nextSessionIds = new Set((nextBatch?.sessions || []).map((session) => String(session._id || "")));
          if (previousBatch.sessions.some((session) => !nextSessionIds.has(String(session._id)))) {
            return res.status(409).json({ error: "A session with registrations cannot be removed. Mark it cancelled or completed to preserve its history." });
          }
        }
      }
    }
    const update = { ...input };
    for (const key of ["instructor", "certificate"]) {
      if (Object.hasOwn(input, key)) update[key] = { ...(item[key]?.toObject ? item[key].toObject() : item[key] || {}), ...input[key] };
    }
    const previous = Object.fromEntries(Object.keys(update).map((key) => [key, item[key]?.toObject ? item[key].toObject() : item[key]]));
    Object.assign(item, update, { updatedBy: req.admin.id }); await item.save(); await audit(req, item, "course.updated", { previous, next: update, ...(Object.hasOwn(req.body || {}, "batches") ? { reason: changeReason } : {}) });
    if (input.batches && JSON.stringify(previous.batches || []) !== JSON.stringify(item.batches.map((batch) => batch.toObject()))) {
      const oldBatches = previous.batches || [];
      const changedBatches = item.batches.filter((batch) => {
        const before = oldBatches.find((item) => String(item._id) === String(batch._id) || item.code === batch.code);
        return !before || JSON.stringify(before) !== JSON.stringify(batch.toObject());
      });
      if (!changedBatches.length) return res.json({ item });
      const hasCancellation = changedBatches.some((batch) => {
        const before = oldBatches.find((item) => String(item._id) === String(batch._id) || item.code === batch.code);
        const hadActiveSessions = before?.sessions?.some((session) => session.status !== "cancelled");
        const hasActiveSessions = batch.sessions.some((session) => session.status !== "cancelled");
        return (batch.status === "cancelled" && before?.status !== "cancelled") || (hadActiveSessions && !hasActiveSessions) || batch.sessions.some((session) => session.status === "cancelled" && !before?.sessions?.some((old) => String(old._id) === String(session._id) && old.status === "cancelled"));
      });
      const type = hasCancellation ? "cancelled" : "schedule_changed";
      await enqueueScheduleNotifications(item.toObject(), type, { reason: changeReason }, changedBatches.map((batch) => batch._id));
      void processCourseNotificationWorkerOnce().catch(() => {});
    }
    return res.json({ item });
  } catch (error) { if (error.code === 11000) return res.status(409).json({ error: "A course already uses that slug." }); return sendError(error, res, next); }
}
export async function uploadCourseImage(req, res, next) {
  if (!idValid(req.params.id)) return res.status(400).json({ error: "Invalid course ID." });
  try {
    if (!req.file) return res.status(400).json({ error: "Select an image file." });
    const type = detectCourseImageType(req.file);
    if (!type) return res.status(400).json({ error: "Use a valid PNG, JPEG or WebP image." });
    const item = await Course.findById(req.params.id);
    if (!item) return res.status(404).json({ error: "Course not found." });
    const filename = `${crypto.randomUUID()}.${type.ext}`;
    const stored = await storeImage({ buffer: req.file.buffer, filename, originalFilename: req.file.originalname, mimeType: type.mime });
    const previousFilename = item.coverImage?.filename;
    item.coverImage = { mediaId: stored.mediaId, filename: stored.filename, originalFilename: stored.originalFilename, mimeType: type.mime, size: stored.size, uploadedAt: stored.uploadedAt, alt: String(req.body?.alt || "").slice(0, 180) };
    item.updatedBy = req.admin.id;
    try { await item.save(); }
    catch (error) { return next(error); }
    await audit(req, item, "course.imageUploaded", { previousFilename: previousFilename || null, filename, mediaId: stored.mediaId, mimeType: type.mime, size: stored.size });
    return res.json({ item: item.coverImage });
  } catch (error) { return next(error); }
}
export async function changeCourseState(req, res, next) {
  if (!idValid(req.params.id)) return res.status(400).json({ error: "Invalid course ID." });
  const { action, scheduledAt } = req.body || {};
  if (!["publish", "schedule", "unpublish", "archive"].includes(action)) return res.status(400).json({ error: "Invalid course action." });
  try {
    const item = await Course.findById(req.params.id); if (!item) return res.status(404).json({ error: "Course not found." });
    if (!canTransitionCourse(item.status, action)) return res.status(409).json({ error: "This course cannot use the requested lifecycle transition." });
    if (action === "publish" && item.deliveryMode === "self-paced") return res.status(409).json({ error: "Only live online, in-person or hybrid programmes can be published for registration." });
    const previous = { status: item.status, scheduledAt: item.scheduledAt };
      if (action === "publish") { const firstPublication = !item.publishedAt; item.status = "published"; item.publishedAt ||= new Date(); item.publishedBy = req.admin.id; item.scheduledAt = null; item.scheduleAuditPending = false; if (firstPublication) item.announcementStatus = "pending"; }
    if (action === "schedule") {
      const date = new Date(scheduledAt);
      if (!scheduledAt || Number.isNaN(date.getTime()) || date <= new Date()) return res.status(400).json({ error: "Choose a future publication time." });
      item.status = "scheduled"; item.scheduledAt = date; item.scheduledBy = req.admin.id; item.scheduleAuditPending = true;
    }
    if (action === "unpublish") { item.status = "unpublished"; item.scheduledAt = null; }
    if (action === "archive") { item.status = "archived"; item.archivedAt = new Date(); item.scheduledAt = null; item.enrollmentOpen = false; }
    item.updatedBy = req.admin.id; await item.save(); await audit(req, item, `course.${action}`, { previous, next: { status: item.status, scheduledAt: item.scheduledAt } });
    item.scheduleAuditPending = false; await item.save();
    return res.json({ item });
  } catch (error) { return next(error); }
}

export async function createPaymentOrder(req, res, next) {
  const gateway = razorpay();
  if (!gateway) return res.status(503).json({ error: "Online course payment is not configured." });
  try {
    const student = validateStudentInput(req.body?.student);
    if (req.body?.termsAccepted !== true || req.body?.termsVersion !== TERMS_VERSION) return res.status(400).json({ error: "Accept the current course purchase terms to continue." });
    if (!idValid(req.params.courseId)) return res.status(404).json({ error: "Course not found." });
    const course = await Course.findById(req.params.courseId).lean();
    if (!payableCourse(course)) return res.status(409).json({ error: "This course is not currently available for enrollment." });
    const batchId = req.body?.batchId || null;
    let selectedBatch = null;
    if (batchId && course.batches?.length) {
      selectedBatch = course.batches.find((batch) => String(batch._id) === String(batchId) || batch.code === batchId);
      if (!selectedBatch) return res.status(400).json({ error: "Choose a valid programme batch." });
      const now = new Date();
      if (selectedBatch.status === "cancelled" || selectedBatch.status === "completed" || selectedBatch.startsAt <= now || (selectedBatch.registrationOpensAt && selectedBatch.registrationOpensAt > now) || (selectedBatch.registrationClosesAt && selectedBatch.registrationClosesAt <= now)) return res.status(409).json({ error: "Registration for this batch is not currently available." });
      if (selectedBatch.sessions?.length && !selectedBatch.sessions.some((session) => session.status !== "cancelled" && session.startsAt > now)) return res.status(409).json({ error: "This batch has no upcoming scheduled sessions." });
    } else if (batchId) return res.status(400).json({ error: "This programme does not have selectable batches." });
    if (course.priceMinor <= 0) return res.status(400).json({ error: "Contact the course team to enroll in this complimentary course." });
    const requestKey = String(req.get("Idempotency-Key") || "");
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestKey)) return res.status(400).json({ error: "A valid idempotency key is required." });
    const existing = await CourseEnrollment.findOne({ requestKey }).select("-requestKey").lean();
    let enrollment = existing;
    if (existing) {
      if (asId(existing.courseId) !== asId(course._id) || String(existing.batchId || "") !== String(selectedBatch?._id || "") || existing.student.email !== student.email || existing.student.name !== student.name || existing.student.phone !== student.phone) return res.status(409).json({ error: "This idempotency key is already associated with a different enrollment request." });
      const payment = await CoursePayment.findOne({ enrollmentId: existing._id }).lean();
      if (payment) return res.status(200).json({ enrollment: { reference: existing.reference }, order: { id: payment.orderId, amount: payment.amountMinor, currency: payment.currency }, keyId: gateway.keyId, checkout: { name: "ProJenius", description: course.title, prefill: { name: student.name, email: student.email, contact: student.phone } } });
    } else {
      enrollment = await CourseEnrollment.create({ reference: `PJ-CRS-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomBytes(8).toString("hex").toUpperCase()}`, requestKey, courseId: course._id, ...(selectedBatch ? { batchId: selectedBatch._id, batchSnapshot: { code: selectedBatch.code, label: selectedBatch.label, deliveryMode: selectedBatch.deliveryMode, startsAt: selectedBatch.startsAt, timezone: selectedBatch.timezone } } : {}), courseSnapshot: { title: course.title, slug: course.slug, amountMinor: course.priceMinor, currency: "INR" }, student, terms: { version: TERMS_VERSION, acceptedAt: new Date(), policy: TERMS_POLICY }, approvalStatus: "awaiting_approval" });
    }
    const order = await gateway.client.orders.create({ amount: course.priceMinor, currency: "INR", receipt: enrollment.reference.slice(-40), notes: { enrollmentReference: enrollment.reference, courseSlug: course.slug } });
    if (!order?.id || Number(order.amount) !== course.priceMinor || order.currency !== "INR") return res.status(502).json({ error: "The payment provider returned an invalid course order." });
    await CoursePayment.create({ enrollmentId: enrollment._id, courseId: course._id, orderId: order.id, amountMinor: course.priceMinor, currency: "INR", status: "created" });
    return res.status(201).json({ enrollment: { reference: enrollment.reference }, order: { id: order.id, amount: order.amount, currency: order.currency }, keyId: gateway.keyId, checkout: { name: "ProJenius", description: course.title, prefill: { name: student.name, email: student.email, contact: student.phone } } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: "This enrollment request is already being processed." });
    if (error instanceof CourseValidationError) return res.status(400).json({ error: error.message });
    return next(error);
  }
}

async function settlePayment({ orderId, paymentId, status, gatewayStatus, amount, currency, fee, failureCode, failureDescription }) {
  const payment = await CoursePayment.findOne({ orderId }); if (!payment) return null;
  if (amount !== undefined && (Number(amount) !== payment.amountMinor || currency !== payment.currency)) throw new Error("Payment amount mismatch");
  if (status === "captured") {
    if (payment.status === "refunded" || payment.status === "partially_refunded") return payment;
    if (payment.status === "captured" && payment.paymentId !== paymentId) throw new Error("Order already settled with another payment");
    if (payment.paymentId && payment.paymentId !== paymentId) payment.attempts.push({ paymentId: payment.paymentId, status: payment.status, gatewayStatus: payment.gatewayStatus, failureCode: payment.failureCode, failureDescription: payment.failureDescription, gatewayFeeMinor: payment.gatewayFeeMinor, recordedAt: new Date() });
    payment.paymentId = paymentId; payment.status = "captured"; payment.gatewayStatus = gatewayStatus || "captured"; payment.capturedAt ||= new Date();
    if (Number.isSafeInteger(fee) && fee >= 0) payment.gatewayFeeMinor = fee;
    await payment.save();
    const enrollmentUpdate = await CourseEnrollment.updateOne({ _id: payment.enrollmentId, status: { $in: ["pending_payment", "payment_failed"] } }, { $set: { status: "enrolled", paidAt: new Date() } });
    if (enrollmentUpdate.modifiedCount) {
      await processVerifiedCourseEnrollment(payment.enrollmentId, payment);
    } else {
      const enrollment = await CourseEnrollment.findById(payment.enrollmentId).lean();
      if (enrollment?.status === "enrolled" && (enrollment.receiptStatus !== "ready" || enrollment.customerEmailStatus !== "sent" || enrollment.adminEmailStatus !== "sent")) {
        await processVerifiedCourseEnrollment(payment.enrollmentId, payment);
      }
    }
  } else if (!["captured", "refunded", "partially_refunded"].includes(payment.status)) {
    if (payment.paymentId && payment.paymentId !== paymentId) payment.attempts.push({ paymentId: payment.paymentId, status: payment.status, gatewayStatus: payment.gatewayStatus, failureCode: payment.failureCode, failureDescription: payment.failureDescription, gatewayFeeMinor: payment.gatewayFeeMinor, recordedAt: new Date() });
    payment.status = status; payment.gatewayStatus = gatewayStatus || status; payment.failureCode = failureCode || null; payment.failureDescription = failureDescription || null; if (paymentId) payment.paymentId = paymentId; await payment.save();
    if (status === "failed") await CourseEnrollment.updateOne({ _id: payment.enrollmentId, status: "pending_payment" }, { $set: { status: "payment_failed" } });
  }
  return payment;
}

export async function verifyCheckoutPayment(req, res, next) {
  const gateway = razorpay(); if (!gateway) return res.status(503).json({ error: "Online course payment is not configured." });
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
  if (![orderId, paymentId, signature].every((x) => typeof x === "string" && x.length < 200)) return res.status(400).json({ error: "Payment verification details are invalid." });
  try {
    const payment = await CoursePayment.findOne({ orderId }); if (!payment) return res.status(404).json({ error: "Payment order not found." });
    if (!verifyPaymentSignature(orderId, paymentId, signature)) return res.status(400).json({ error: "Payment signature could not be verified." });
    const fetched = await gateway.client.payments.fetch(paymentId);
    if (fetched.order_id !== orderId || Number(fetched.amount) !== payment.amountMinor || fetched.currency !== payment.currency) return res.status(400).json({ error: "Payment does not match the course order." });
    if (fetched.status !== "captured") {
      await settlePayment({ orderId, paymentId, status: fetched.status === "failed" ? "failed" : "authorized", gatewayStatus: fetched.status, amount: fetched.amount, currency: fetched.currency, fee: fetched.fee, failureCode: fetched.error_code, failureDescription: fetched.error_description });
      return res.status(202).json({ status: fetched.status, reference: (await CourseEnrollment.findById(payment.enrollmentId).select("reference").lean())?.reference });
    }
    await settlePayment({ orderId, paymentId, status: "captured", gatewayStatus: fetched.status, amount: fetched.amount, currency: fetched.currency, fee: fetched.fee });
    const enrollment = await CourseEnrollment.findById(payment.enrollmentId).select("reference status").lean();
    const receipt = enrollment?.status === "enrolled" ? await CourseReceipt.findOne({ enrollmentId: payment.enrollmentId }).lean() : null;
    let receiptUrl;
    if (receipt) {
      const token = crypto.randomBytes(32).toString("base64url");
      await CourseEnrollment.updateOne({ _id: payment.enrollmentId, status: "enrolled" }, { $set: { receiptTokenHash: crypto.createHash("sha256").update(token).digest("hex"), receiptTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } });
      receiptUrl = `/api/courses/receipt/${token}`;
    }
    return res.json({ status: enrollment?.status === "enrolled" ? "captured" : enrollment?.status, reference: enrollment?.reference, ...(receiptUrl ? { receiptUrl } : {}) });
  } catch (error) { if (error.code === 11000 || /mismatch|another payment/.test(error.message)) return res.status(409).json({ error: "Payment verification did not match the recorded order." }); return next(error); }
}

export async function recordPaymentFailure(req, res, next) {
  const gateway = razorpay();
  if (!gateway) return res.status(503).json({ error: "Online course payment is not configured." });
  const { orderId, paymentId } = req.body || {};
  if (![orderId, paymentId].every((value) => typeof value === "string" && value.length > 0 && value.length < 200)) return res.status(400).json({ error: "Payment attempt details are invalid." });
  try {
    const order = await CoursePayment.findOne({ orderId }).lean();
    if (!order) return res.status(404).json({ error: "Payment order not found." });
    const payment = await gateway.client.payments.fetch(paymentId);
    if (payment.order_id !== orderId || Number(payment.amount) !== order.amountMinor || payment.currency !== order.currency) return res.status(400).json({ error: "Payment attempt does not match the recorded course order." });
    const status = payment.status === "captured" ? "captured" : payment.status === "failed" ? "failed" : "authorized";
    await settlePayment({ orderId, paymentId, status, gatewayStatus: payment.status, amount: payment.amount, currency: payment.currency, fee: payment.fee, failureCode: payment.error_code, failureDescription: payment.error_description });
    return res.json({ status });
  } catch (error) { return next(error); }
}

export async function downloadPublicCourseReceipt(req, res, next) {
  const token = String(req.params.token || "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return res.status(404).json({ error: "This receipt link is invalid or expired." });
  try {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const enrollment = await CourseEnrollment.findOne({ receiptTokenHash: tokenHash, receiptTokenExpiresAt: { $gt: new Date() }, status: "enrolled" }).select("+receiptTokenHash +receiptTokenExpiresAt").lean();
    if (!enrollment) return res.status(404).json({ error: "This receipt link is invalid or expired." });
    const payment = await CoursePayment.findOne({ enrollmentId: enrollment._id, status: { $in: ["captured", "partially_refunded", "refunded"] } }).sort({ capturedAt: -1 }).lean();
    const receipt = await CourseReceipt.findOne({ enrollmentId: enrollment._id }).lean();
    if (!payment || !receipt || String(receipt.paymentId) !== String(payment._id)) return res.status(404).json({ error: "This receipt link is invalid or expired." });
    const pdf = await readCourseReceiptFile(receipt.filename);
    if (crypto.createHash("sha256").update(pdf).digest("hex") !== receipt.sha256) return res.status(404).json({ error: "This receipt link is invalid or expired." });
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="ProJenius-Course-${enrollment.reference}.pdf"`, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" });
    return res.send(pdf);
  } catch (error) { return next(error); }
}

export async function requestCourseReceiptLink(req, res, next) {
  const reference = typeof req.body?.reference === "string" ? req.body.reference.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (reference.length <= 100 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    try {
      const enrollment = await CourseEnrollment.findOne({ reference, "student.email": email, status: "enrolled" }).lean();
      if (enrollment) {
        const payment = await CoursePayment.findOne({ enrollmentId: enrollment._id, status: { $in: ["captured", "partially_refunded", "refunded"] } }).lean();
        const course = await Course.findById(enrollment.courseId).lean();
        if (payment && course) await enqueueCourseNotification({ enrollment, course, type: "receipt_link", dedupeKey: `${enrollment._id}:receipt_link:${crypto.randomUUID()}` });
      }
    } catch (error) { return next(error); }
  }
  void processCourseNotificationWorkerOnce().catch(() => {});
  return res.status(202).json({ message: "If the registration details match, a secure receipt link will be emailed to the registered address." });
}

export async function razorpayWebhook(req, res) {
  const signature = req.get("X-Razorpay-Signature") || "";
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    console.warn("Razorpay webhook rejected: webhook secret is not configured.");
    return res.sendStatus(503);
  }
  if (!Buffer.isBuffer(req.body)) return res.sendStatus(400);
  if (!verifyWebhookSignature(req.body, signature)) return res.sendStatus(400);
  let body;
  try { body = JSON.parse(req.body.toString("utf8")); } catch { return res.sendStatus(400); }
  const eventId = String(req.get("x-razorpay-event-id") || "");
  if (!eventId || eventId.length > 200) return res.sendStatus(400);
  let event;
  try {
    const digest = crypto.createHash("sha256").update(req.body).digest("hex");
    event = await CourseWebhookEvent.findOne({ eventId }).select("+payloadHash");
    if (!event) {
      try { event = await CourseWebhookEvent.create({ eventId, event: String(body.event || "unknown").slice(0, 100), payloadHash: digest, status: "received" }); }
      catch (error) { if (error.code !== 11000) throw error; event = await CourseWebhookEvent.findOne({ eventId }).select("+payloadHash"); }
    }
    if (!event || event.payloadHash !== digest) return res.sendStatus(400);
    if (event.status === "processed" || event.status === "ignored") return res.sendStatus(200);
    const entity = body.payload?.payment?.entity || body.payload?.refund?.entity || {};
    const orderId = entity.order_id;
    if (orderId && (body.event === "payment.captured" || body.event === "payment.authorized" || body.event === "payment.failed")) {
      const status = body.event === "payment.captured" ? "captured" : body.event === "payment.failed" ? "failed" : "authorized";
      await settlePayment({ orderId, paymentId: entity.id, status, gatewayStatus: entity.status, amount: entity.amount, currency: entity.currency, fee: entity.fee, failureCode: entity.error_code, failureDescription: entity.error_description });
    }
    if (entity.payment_id && String(body.event || "").startsWith("refund.")) {
      const payment = await CoursePayment.findOne({ paymentId: entity.payment_id });
      if (payment) {
        const refundId = entity.id;
        const incomingStatus = body.event === "refund.processed" ? "processed" : body.event === "refund.failed" ? "failed" : "pending";
        const statusRank = { requested: 0, pending: 1, failed: 2, processed: 3 };
        const existingRefund = await CourseRefund.findOne({ providerRefundId: refundId });
        if (!existingRefund) {
          try { await CourseRefund.create({ enrollmentId: payment.enrollmentId, paymentId: payment._id, providerRefundId: refundId, amountMinor: entity.amount, currency: entity.currency || payment.currency, status: incomingStatus, reason: "Provider refund event", processedAt: incomingStatus === "processed" ? new Date() : null }); }
          catch (error) { if (error.code !== 11000) throw error; }
        } else if ((statusRank[incomingStatus] || 0) >= (statusRank[existingRefund.status] || 0)) {
          existingRefund.status = incomingStatus;
          existingRefund.processedAt = incomingStatus === "processed" ? new Date() : existingRefund.processedAt;
          await existingRefund.save();
        }
        const refunds = await CourseRefund.find({ paymentId: payment._id, status: "processed" }).lean();
        payment.refundedAmountMinor = refunds.reduce((sum, item) => sum + item.amountMinor, 0);
        payment.status = payment.refundedAmountMinor >= payment.amountMinor ? "refunded" : payment.refundedAmountMinor ? "partially_refunded" : payment.status;
        await payment.save();
        await CourseAudit.updateOne({ eventKey: `refund-webhook:${eventId}` }, { $setOnInsert: { courseId: payment.courseId, actorId: null, action: `provider.refund.${incomingStatus}`, changes: { refundId, amountMinor: entity.amount, currency: entity.currency || payment.currency, status: incomingStatus }, metadata: { enrollmentId: String(payment.enrollmentId), eventId } } }, { upsert: true });
        if (payment.status === "refunded") await CourseEnrollment.updateOne({ _id: payment.enrollmentId }, { $set: { status: "refunded" } });
      }
    }
    event.status = "processed"; event.processedAt = new Date(); await event.save();
    return res.sendStatus(200);
  } catch (error) {
    if (error.code === 11000) {
      event.status = "failed";
      await event.save();
      return res.sendStatus(409);
    }
    // Do not acknowledge processing failures; Razorpay may retry the event.
    return res.sendStatus(500);
  }
}

export async function listCourseEnrollments(req, res, next) {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1), limit = safeInt(req.query.limit, 20);
    const filter = {};
    if (req.query.status) {
      if (!["pending_payment", "enrolled", "payment_failed", "cancelled", "refunded"].includes(req.query.status)) return res.status(400).json({ error: "Invalid enrollment status." });
      filter.status = req.query.status;
    }
    if (req.query.approvalStatus) {
      if (!["awaiting_approval", "approved", "rejected"].includes(req.query.approvalStatus)) return res.status(400).json({ error: "Invalid approval status." });
      filter.approvalStatus = req.query.approvalStatus;
    }
    if (req.query.courseId) { if (!idValid(req.query.courseId)) return res.status(400).json({ error: "Invalid course ID." }); filter.courseId = req.query.courseId; }
    if (req.query.search) {
      if (typeof req.query.search !== "string" || req.query.search.length > 120) return res.status(400).json({ error: "Enrolment search is invalid." });
      const match = new RegExp(escapeRegex(req.query.search.trim()), "i");
      filter.$or = [{ reference: match }, { "student.email": match }, { "student.name": match }];
    }
    const range = dateRange(req.query); if (range) filter.createdAt = range;
    const [items, total] = await Promise.all([CourseEnrollment.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), CourseEnrollment.countDocuments(filter)]);
    return res.json({ items: items.map((item) => ({ ...item, approvalStatus: item.approvalStatus || (item.status === "enrolled" ? "awaiting_approval" : null) })), pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { return next(error); }
}

export async function getCourseEnrollment(req, res, next) {
  if (!idValid(req.params.id)) return res.status(400).json({ error: "Invalid registration ID." });
  try {
    const enrollment = await CourseEnrollment.findById(req.params.id).lean();
    if (!enrollment) return res.status(404).json({ error: "Registration not found." });
    const [course, payment, refunds] = await Promise.all([
      Course.findById(enrollment.courseId).lean(),
      CoursePayment.findOne({ enrollmentId: enrollment._id }).lean(),
      CourseRefund.find({ enrollmentId: enrollment._id }).sort({ createdAt: -1 }).lean(),
    ]);
    const canViewPrivate = req.admin?.role === "superadmin" || req.admin?.permissions?.includes("courses:view");
    const batch = (course?.batches || []).find((item) => String(item._id) === String(enrollment.batchId));
    const safeBatch = batch ? JSON.parse(JSON.stringify(batch)) : null;
    if (safeBatch && !canViewPrivate) for (const session of safeBatch.sessions || []) for (const key of ["onlinePlatform", "onlineJoinUrl", "onlineAccessCode", "venueName", "venueAddress", "reportingTime"]) delete session[key];
    return res.json({ item: {
      ...enrollment,
      approvalStatus: enrollment.approvalStatus || (enrollment.status === "enrolled" ? "awaiting_approval" : null),
      course: course ? { title: course.title, slug: course.slug, deliveryMode: enrollment.batchSnapshot?.deliveryMode || course.deliveryMode, startDate: enrollment.batchSnapshot?.startsAt || course.startDate, duration: course.duration, batch: safeBatch, ...(canViewPrivate ? { deliveryDetails: course.deliveryDetails } : {}) } : null,
      payment,
      refunds,
    } });
  } catch (error) { return next(error); }
}

async function sendDecisionNotification(enrollmentId) {
  const enrollment = await CourseEnrollment.findById(enrollmentId).lean();
  if (!enrollment || !["approved", "rejected"].includes(enrollment.approvalStatus)) return null;
  const course = await Course.findById(enrollment.courseId).lean();
  if (!course) return null;
  await enqueueDecisionNotification(enrollment, course, enrollment.approvalStatus);
  const result = await processCourseNotificationWorkerOnce();
  const outcome = await CourseEnrollment.findById(enrollmentId).select("approvalEmailStatus").lean();
  return { status: outcome?.approvalEmailStatus || result[0]?.status || "queued" };
}

export async function decideCourseEnrollment(req, res, next) {
  const { action, reason = "" } = req.body || {};
  if (!idValid(req.params.id)) return res.status(400).json({ error: "Invalid registration ID." });
  if (!["approve", "reject"].includes(action)) return res.status(400).json({ error: "Choose approve or reject." });
  if (action === "reject" && (typeof reason !== "string" || reason.trim().length < 5 || reason.trim().length > 500)) return res.status(400).json({ error: "Provide a rejection reason between 5 and 500 characters." });
  try {
    const enrollment = await CourseEnrollment.findById(req.params.id).lean();
    if (!enrollment) return res.status(404).json({ error: "Registration not found." });
    if (enrollment.status !== "enrolled") return res.status(409).json({ error: "Only a verified captured registration can be reviewed." });
    const payment = await CoursePayment.findOne({ enrollmentId: enrollment._id, status: { $in: ["captured", "partially_refunded"] } }).lean();
    if (!payment) return res.status(409).json({ error: "A captured payment is required before review." });
    const currentApproval = enrollment.approvalStatus || "awaiting_approval";
    if (currentApproval !== "awaiting_approval") return res.status(409).json({ error: "This registration has already been reviewed." });
    const course = await Course.findById(enrollment.courseId).lean();
    if (!course) return res.status(409).json({ error: "The programme associated with this registration is unavailable." });
    const status = action === "approve" ? "approved" : "rejected";
    const at = new Date();
    const decisionReason = action === "reject" ? reason.trim() : "";
    const updated = await CourseEnrollment.updateOne(
      { _id: enrollment._id, status: "enrolled", $or: [{ approvalStatus: "awaiting_approval" }, { approvalStatus: { $exists: false } }] },
      { $set: { approvalStatus: status, approvalReason: decisionReason, approvalAt: at, approvalBy: req.admin.id, approvalEmailStatus: "pending" }, $push: { approvalHistory: { action: status, reason: decisionReason, actorAdminId: req.admin.id, at } } },
    );
    if (!updated.modifiedCount) {
      return res.status(409).json({ error: "This registration was reviewed by another administrator." });
    }
    await CourseAudit.create({ eventKey: `registration-decision:${enrollment._id}:${at.getTime()}`, courseId: course._id, actorId: req.admin.id, action: `registration.${status}`, changes: { approvalStatus: { from: "awaiting_approval", to: status }, reason: decisionReason }, metadata: { enrollmentId: String(enrollment._id), reference: enrollment.reference } });
    const notification = await sendDecisionNotification(enrollment._id);
    return res.json({ item: { id: String(enrollment._id), reference: enrollment.reference, approvalStatus: status, approvalEmailStatus: notification?.status || "failed" } });
  } catch (error) { return next(error); }
}

export async function retryCourseDecisionNotification(req, res, next) {
  if (!idValid(req.params.id)) return res.status(400).json({ error: "Invalid registration ID." });
  try {
    const enrollment = await CourseEnrollment.findById(req.params.id).lean();
    if (!enrollment) return res.status(404).json({ error: "Registration not found." });
    if (!["approved", "rejected"].includes(enrollment.approvalStatus)) return res.status(409).json({ error: "A reviewed registration is required before sending this notification." });
    if (enrollment.approvalEmailStatus === "sent") return res.status(409).json({ error: "The decision email was already sent." });
    await retryCourseNotificationsForEnrollment(enrollment._id, [enrollment.approvalStatus]);
    const updated = await CourseEnrollment.findById(enrollment._id).select("approvalEmailStatus").lean();
    return res.json({ item: { reference: enrollment.reference, approvalStatus: enrollment.approvalStatus, approvalEmailStatus: updated?.approvalEmailStatus || "failed" } });
  } catch (error) { return next(error); }
}

export async function retryCoursePaymentNotifications(req, res, next) {
  if (!idValid(req.params.id)) return res.status(400).json({ error: "Invalid registration ID." });
  try {
    const enrollment = await CourseEnrollment.findById(req.params.id).lean();
    if (!enrollment || enrollment.status !== "enrolled") return res.status(404).json({ error: "A captured registration was not found." });
    const payment = await CoursePayment.findOne({ enrollmentId: enrollment._id, status: { $in: ["captured", "partially_refunded"] } }).sort({ capturedAt: -1 }).lean();
    if (!payment) return res.status(409).json({ error: "A verified captured payment is required before retrying notifications." });
    await retryCourseNotificationsForEnrollment(enrollment._id, ["payment_customer", "payment_admin"]);
    const updated = await CourseEnrollment.findById(enrollment._id).select("receiptStatus customerEmailStatus adminEmailStatus").lean();
    return res.json({ item: { reference: enrollment.reference, ...updated } });
  } catch (error) { return next(error); }
}
export async function listCourseNotifications(req, res, next) {
  try { return res.json(await listCourseNotificationJobs(req.query)); }
  catch (error) { return res.status(400).json({ error: error.message || "Notification filters are invalid." }); }
}
export async function retryCourseNotification(req, res, next) {
  if (!idValid(req.params.id)) return res.status(400).json({ error: "Invalid notification ID." });
  try {
    const retried = await retryCourseNotificationJob(req.params.id);
    if (!retried) return res.status(409).json({ error: "Only failed or unconfigured notifications can be retried." });
    return res.json({ item: { id: req.params.id, status: "queued" } });
  } catch (error) { return next(error); }
}
export async function listCoursePayments(req, res, next) {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1), limit = safeInt(req.query.limit, 20);
    const filter = {};
    if (req.query.status) {
      if (!["created", "pending", "authorized", "captured", "failed", "cancelled", "refunded", "partially_refunded"].includes(req.query.status)) return res.status(400).json({ error: "Invalid payment status." });
      filter.status = req.query.status;
    }
    if (req.query.search) {
      if (typeof req.query.search !== "string" || req.query.search.length > 120) return res.status(400).json({ error: "Payment search is invalid." });
      const match = new RegExp(escapeRegex(req.query.search.trim()), "i"); filter.$or = [{ orderId: match }, { paymentId: match }];
    }
    const range = dateRange(req.query); if (range) filter.createdAt = range;
    if (req.query.courseId) { if (!idValid(req.query.courseId)) return res.status(400).json({ error: "Invalid course ID." }); filter.courseId = req.query.courseId; }
    const [items, total] = await Promise.all([CoursePayment.find(filter).populate("courseId", "title slug").populate("enrollmentId", "reference student status").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), CoursePayment.countDocuments(filter)]);
    return res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { return next(error); }
}
export async function courseAnalytics(req, res, next) {
  try {
    const range = dateRange(req.query);
    const paymentMatch = { status: { $in: ["captured", "partially_refunded", "refunded"] } };
    if (range) paymentMatch.createdAt = range;
    const enrollmentFilter = range ? { createdAt: range } : {};
    const [courseCounts, enrollmentCounts, paymentStates, paymentTotals, courseWise] = await Promise.all([
      Course.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      CourseEnrollment.aggregate([{ $match: enrollmentFilter }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
      CoursePayment.aggregate([{ $match: range ? { createdAt: range } : {} }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
      CoursePayment.aggregate([{ $match: paymentMatch }, { $group: { _id: null, grossMinor: { $sum: "$amountMinor" }, refundedMinor: { $sum: "$refundedAmountMinor" }, gatewayFeeMinor: { $sum: { $ifNull: ["$gatewayFeeMinor", 0] } }, capturedCount: { $sum: 1 } } }]),
      Course.aggregate([
        { $lookup: { from: "course_enrollments", localField: "_id", foreignField: "courseId", as: "enrollments" } },
        { $lookup: { from: "course_payments", localField: "_id", foreignField: "courseId", as: "payments" } },
        { $project: {
          title: 1, slug: 1, status: 1, internalCostMinor: 1,
          enrolments: { $size: { $filter: { input: "$enrollments", as: "e", cond: range ? { $and: [{ $eq: ["$$e.status", "enrolled"] }, { $gte: ["$$e.createdAt", range.$gte || new Date(0)] }, { $lte: ["$$e.createdAt", range.$lte || new Date("9999-12-31")] }] } : { $eq: ["$$e.status", "enrolled"] } } } },
          capturedPayments: { $size: { $filter: { input: "$payments", as: "p", cond: { $and: [{ $in: ["$$p.status", ["captured", "partially_refunded", "refunded"]] }, ...(range ? [{ $gte: ["$$p.createdAt", range.$gte || new Date(0)] }, { $lte: ["$$p.createdAt", range.$lte || new Date("9999-12-31")] }] : [])] } } } },
          paymentAttempts: { $size: { $filter: { input: "$payments", as: "p", cond: range ? { $and: [{ $gte: ["$$p.createdAt", range.$gte || new Date(0)] }, { $lte: ["$$p.createdAt", range.$lte || new Date("9999-12-31")] }] } : true } } },
          pendingPayments: { $size: { $filter: { input: "$payments", as: "p", cond: { $and: [{ $in: ["$$p.status", ["created", "pending", "authorized"]] }, ...(range ? [{ $gte: ["$$p.createdAt", range.$gte || new Date(0)] }, { $lte: ["$$p.createdAt", range.$lte || new Date("9999-12-31")] }] : [])] } } } },
          failedPayments: { $size: { $filter: { input: "$payments", as: "p", cond: { $and: [{ $in: ["$$p.status", ["failed", "cancelled"]] }, ...(range ? [{ $gte: ["$$p.createdAt", range.$gte || new Date(0)] }, { $lte: ["$$p.createdAt", range.$lte || new Date("9999-12-31")] }] : [])] } } } },
          grossMinor: { $sum: { $map: { input: { $filter: { input: "$payments", as: "p", cond: { $and: [{ $in: ["$$p.status", ["captured", "partially_refunded", "refunded"]] }, ...(range ? [{ $gte: ["$$p.createdAt", range.$gte || new Date(0)] }, { $lte: ["$$p.createdAt", range.$lte || new Date("9999-12-31")] }] : [])] } } }, as: "p", in: "$$p.amountMinor" } } },
          refundedMinor: { $sum: { $map: { input: { $filter: { input: "$payments", as: "p", cond: range ? { $and: [{ $gte: ["$$p.createdAt", range.$gte || new Date(0)] }, { $lte: ["$$p.createdAt", range.$lte || new Date("9999-12-31")] }] } : true } }, as: "p", in: "$$p.refundedAmountMinor" } } },
          gatewayFeeMinor: { $sum: { $map: { input: { $filter: { input: "$payments", as: "p", cond: range ? { $and: [{ $gte: ["$$p.createdAt", range.$gte || new Date(0)] }, { $lte: ["$$p.createdAt", range.$lte || new Date("9999-12-31")] }] } : true } }, as: "p", in: { $ifNull: ["$$p.gatewayFeeMinor", 0] } } } },
        } }, { $sort: { title: 1 } }, { $limit: 500 },
      ]),
    ]);
    const counts = Object.fromEntries(courseCounts.map((x) => [x._id, x.count]));
    const enrollmentMap = Object.fromEntries(enrollmentCounts.map((x) => [x._id, x.count]));
    const txMap = Object.fromEntries(paymentStates.map((x) => [x._id, x.count]));
    const p = paymentTotals[0] || {}, grossMinor = p.grossMinor || 0, refundMinor = p.refundedMinor || 0, fees = p.gatewayFeeMinor || 0;
    return res.json({ item: {
      courses: { total: Object.values(counts).reduce((a, b) => a + b, 0), draft: counts.draft || 0, scheduled: counts.scheduled || 0, published: counts.published || 0, unpublished: counts.unpublished || 0, archived: counts.archived || 0 },
      enrolments: { total: Object.values(enrollmentMap).reduce((a, b) => a + b, 0), enrolled: enrollmentMap.enrolled || 0, pending: enrollmentMap.pending_payment || 0, failed: enrollmentMap.payment_failed || 0 },
      payments: { captured: p.capturedCount || 0, pending: (txMap.created || 0) + (txMap.pending || 0) + (txMap.authorized || 0), failed: (txMap.failed || 0) + (txMap.cancelled || 0), grossCapturedMinor: grossMinor, refundedMinor: refundMinor, refundAdjustedMinor: grossMinor - refundMinor, gatewayFeesMinor: fees, estimatedNetAfterReportedFeesMinor: grossMinor - refundMinor - fees, gatewayFeeCoverage: fees ? "Fees reported by the payment provider for captured transactions." : "Provider fee data is not available; no fee estimate has been invented." },
      dateRange: range ? { from: range.$gte || null, to: range.$lte || null, basis: "Enrolment creation and payment order creation dates; course lifecycle counts are all-time." } : null,
      courseWise: courseWise.map((row) => ({ ...row, refundAdjustedMinor: row.grossMinor - row.refundedMinor, estimatedNetAfterReportedFeesMinor: row.grossMinor - row.refundedMinor - row.gatewayFeeMinor, paymentSuccessRate: row.paymentAttempts ? Math.round(row.capturedPayments / row.paymentAttempts * 10000) / 100 : 0, estimatedContributionMinor: Number.isSafeInteger(row.internalCostMinor) ? row.grossMinor - row.refundedMinor - row.gatewayFeeMinor - row.internalCostMinor : null })),
    } });
  } catch (error) { return next(error); }
}
export async function exportCourseReport(_req, res, next) {
  try {
    const rows = await CourseEnrollment.find().populate("courseId", "title").sort({ createdAt: -1 }).lean();
    const quote = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const csv = ["reference,course,status,studentEmail,amountMinor,currency,createdAt", ...rows.map((x) => [x.reference, x.courseSnapshot?.title || x.courseId?.title, x.status, x.student?.email, x.courseSnapshot?.amountMinor, x.courseSnapshot?.currency, x.createdAt?.toISOString()].map(quote).join(","))].join("\r\n");
    res.set("Content-Type", "text/csv; charset=utf-8"); res.set("Content-Disposition", 'attachment; filename="course-enrollments.csv"');
    return res.send(csv);
  } catch (error) { return next(error); }
}
export async function listCourseRefunds(req, res, next) {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1), limit = safeInt(req.query.limit, 20);
    const filter = {};
    if (req.query.status) { if (!["requested", "pending", "processed", "failed"].includes(req.query.status)) return res.status(400).json({ error: "Invalid refund status." }); filter.status = req.query.status; }
    if (req.query.search) { if (typeof req.query.search !== "string" || req.query.search.length > 120) return res.status(400).json({ error: "Refund search is invalid." }); filter.providerRefundId = new RegExp(escapeRegex(req.query.search.trim()), "i"); }
    const range = dateRange(req.query); if (range) filter.createdAt = range;
    const [items, total] = await Promise.all([CourseRefund.find(filter).populate("enrollmentId", "reference student").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), CourseRefund.countDocuments(filter)]);
    return res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { return next(error); }
}
export async function downloadCourseReceipt(req, res, next) {
  if (!idValid(req.params.id)) return res.status(400).json({ error: "Invalid enrolment ID." });
  try {
    const enrollment = await CourseEnrollment.findById(req.params.id).lean();
    if (!enrollment || enrollment.status !== "enrolled") return res.status(404).json({ error: "A verified course receipt was not found." });
    const payment = await CoursePayment.findOne({ enrollmentId: enrollment._id, status: { $in: ["captured", "partially_refunded", "refunded"] } }).sort({ capturedAt: -1 }).lean();
    if (!payment) return res.status(404).json({ error: "A verified course receipt was not found." });
    const { buffer: pdf } = await getOrCreateCourseReceipt({ enrollment, payment, details: { reference: enrollment.reference, student: enrollment.student, courseTitle: enrollment.courseSnapshot.title, amountMinor: payment.amountMinor, paymentId: payment.paymentId, paidAt: payment.capturedAt } });
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `attachment; filename="ProJenius-Course-${enrollment.reference}.pdf"`);
    res.set("Cache-Control", "private, no-store");
    return res.send(pdf);
  } catch (error) { return next(error); }
}
export { TERMS_VERSION };
