import crypto from "node:crypto";
import Course from "./course.model.js";
import CourseEnrollment from "./courseEnrollment.model.js";
import CoursePayment from "./coursePayment.model.js";
import CourseNotificationJob from "./courseNotificationJob.model.js";
import { getOrCreateCourseReceipt } from "./courseReceipt.service.js";
import { sendCourseDecisionEmail, sendCourseNotificationEmails, sendCourseReceiptLinkEmail, sendCourseScheduleEmail } from "../../shared/email/email.service.js";

const intSetting = (name, fallback, min, max) => {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};
const maxAttempts = () => intSetting("COURSE_NOTIFICATION_MAX_ATTEMPTS", 5, 1, 20);
const retryBaseMs = () => intSetting("COURSE_NOTIFICATION_RETRY_BASE_SECONDS", 30, 1, 3600) * 1000;
const genericError = (error) => error?.code ? `Notification delivery failed (${String(error.code).replace(/[^\w-]/g, "").slice(0, 40)}).` : "Notification delivery failed.";
let testRuntime;

export function setCourseNotificationQueueRuntimeForTests(runtime) {
  if (process.env.NODE_ENV !== "test") throw new Error("Course notification test runtime is only available in test mode.");
  const previous = testRuntime;
  testRuntime = runtime;
  return () => { testRuntime = previous; };
}

export async function enqueueCourseNotification({ enrollment, course, type, dedupeKey, context = {} }) {
  const recipient = type === "payment_admin" ? process.env.ADMIN_NOTIFICATION_EMAIL?.trim() : enrollment.student.email;
  const storedDedupeKey = `sha256:${crypto.createHash("sha256").update(String(dedupeKey)).digest("hex")}`;
  try {
    return await CourseNotificationJob.create({
      dedupeKey: storedDedupeKey, enrollmentId: enrollment._id, courseId: course._id, type,
      recipient: recipient || "not_configured", maxAttempts: maxAttempts(), context,
    });
  } catch (error) {
    if (error.code === 11000) return CourseNotificationJob.findOne({ dedupeKey: storedDedupeKey });
    throw error;
  }
}

export async function enqueuePaymentNotifications(enrollment, course, payment) {
  const jobs = await Promise.all([
    enqueueCourseNotification({ enrollment, course, type: "payment_customer", dedupeKey: `${enrollment._id}:payment_customer:${payment.paymentId}` }),
    enqueueCourseNotification({ enrollment, course, type: "payment_admin", dedupeKey: `${enrollment._id}:payment_admin:${payment.paymentId}` }),
  ]);
  return jobs;
}

export async function enqueueDecisionNotification(enrollment, course, decision) {
  return enqueueCourseNotification({ enrollment, course, type: decision, dedupeKey: `${enrollment._id}:${decision}:${enrollment.approvalAt?.getTime() || Date.now()}` });
}

export async function enqueueScheduleNotifications(course, type, change, batchIds = []) {
  const filter = { courseId: course._id, status: "enrolled", approvalStatus: "approved" };
  if (batchIds.length) filter.batchId = { $in: batchIds };
  const enrollments = await CourseEnrollment.find(filter).lean();
  return Promise.all(enrollments.map((enrollment) => enqueueCourseNotification({
    enrollment, course, type,
    dedupeKey: `${enrollment._id}:${type}:${course.updatedAt?.getTime() || Date.now()}`,
    context: { change },
  })));
}

async function deliver(job) {
  const [enrollment, course] = await Promise.all([
    CourseEnrollment.findById(job.enrollmentId).lean(),
    Course.findById(job.courseId).lean(),
  ]);
  if (!enrollment || !course) return { status: "failed", error: "Related registration or programme is unavailable." };

  if (job.type === "payment_customer" || job.type === "payment_admin") {
    const payment = await CoursePayment.findOne({ enrollmentId: enrollment._id, status: { $in: ["captured", "partially_refunded", "refunded"] } }).sort({ capturedAt: -1 }).lean();
    if (!payment) return { status: "failed", error: "Verified payment record is unavailable." };
    let pdfBuffer;
    try {
      const receipt = await getOrCreateCourseReceipt({ enrollment, payment, details: { reference: enrollment.reference, student: enrollment.student, courseTitle: enrollment.courseSnapshot.title, amountMinor: payment.amountMinor, paymentId: payment.paymentId, paidAt: payment.capturedAt || enrollment.paidAt }, generate: testRuntime?.generateReceipt });
      pdfBuffer = receipt.buffer;
      await CourseEnrollment.updateOne({ _id: enrollment._id }, { $set: { receiptStatus: "ready" } });
    } catch (error) {
      await CourseEnrollment.updateOne({ _id: enrollment._id }, { $set: { receiptStatus: "failed" } });
      if (job.type === "payment_customer") return { status: "failed", error };
    }
    const channel = job.type === "payment_customer" ? "customer" : "admin";
    const details = { reference: enrollment.reference, student: enrollment.student, courseTitle: enrollment.courseSnapshot.title, amountMinor: payment.amountMinor, paymentId: payment.paymentId, paidAt: payment.capturedAt || enrollment.paidAt, pdfBuffer };
    const result = testRuntime?.sendEmails ? await testRuntime.sendEmails(details, { customer: channel === "customer", admin: channel === "admin" }) : await sendCourseNotificationEmails(details, { customer: channel === "customer", admin: channel === "admin" });
    const outcome = result[channel] || { status: "failed" };
    await CourseEnrollment.updateOne({ _id: enrollment._id }, { $set: { [channel === "customer" ? "customerEmailStatus" : "adminEmailStatus"]: outcome.status } });
    return outcome;
  }

  if (job.type === "receipt_link") {
    const payment = await CoursePayment.findOne({ enrollmentId: enrollment._id, status: { $in: ["captured", "partially_refunded", "refunded"] } }).sort({ capturedAt: -1 }).lean();
    if (!payment) return { status: "failed", error: "Verified payment record is unavailable." };
    const originValue = process.env.PUBLIC_SITE_ORIGIN?.trim();
    let origin;
    try { origin = new URL(originValue); } catch { return { status: "not_configured" }; }
    if (!["https:", "http:"].includes(origin.protocol) || (origin.protocol === "http:" && !["localhost", "127.0.0.1"].includes(origin.hostname))) return { status: "not_configured" };
    const details = { reference: enrollment.reference, student: enrollment.student, courseTitle: enrollment.courseSnapshot.title, amountMinor: payment.amountMinor, paymentId: payment.paymentId, paidAt: payment.capturedAt || enrollment.paidAt };
    const receipt = await getOrCreateCourseReceipt({ enrollment, payment, details, generate: testRuntime?.generateReceipt });
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await CourseEnrollment.updateOne({ _id: enrollment._id, status: "enrolled" }, { $set: { receiptTokenHash: crypto.createHash("sha256").update(token).digest("hex"), receiptTokenExpiresAt: expiresAt, receiptStatus: "ready" } });
    const url = `${origin.origin}/services/courses/receipt/${token}`;
    return testRuntime?.sendReceiptLink ? testRuntime.sendReceiptLink({ enrollment, course, payment, pdfBuffer: receipt.buffer, url }) : sendCourseReceiptLinkEmail({ enrollment, course, payment, pdfBuffer: receipt.buffer, url });
  }

  if (job.type === "approved" || job.type === "rejected") {
    const result = testRuntime?.sendDecisionEmail ? await testRuntime.sendDecisionEmail({ enrollment, course, decision: job.type, reason: enrollment.approvalReason }) : await sendCourseDecisionEmail({ enrollment, course, decision: job.type, reason: enrollment.approvalReason });
    await CourseEnrollment.updateOne({ _id: enrollment._id, approvalStatus: job.type }, { $set: { approvalEmailStatus: result.status } });
    return result;
  }

  const result = testRuntime?.sendScheduleEmail ? await testRuntime.sendScheduleEmail({ enrollment, course, cancelled: job.type === "cancelled", change: job.context?.change || {} }) : await sendCourseScheduleEmail({ enrollment, course, cancelled: job.type === "cancelled", change: job.context?.change || {} });
  return result;
}

export async function processCourseNotificationWorkerOnce({ limit = 20, now = new Date() } = {}) {
  const outcomes = [];
  await CourseNotificationJob.updateMany({ status: "processing", leaseUntil: { $lte: now }, $expr: { $gte: ["$attempts", "$maxAttempts"] } }, { $set: { status: "failed", leaseUntil: null, finalFailure: true, lastError: "Worker lease expired after the retry limit." } });
  for (let index = 0; index < Math.min(100, Math.max(1, limit)); index += 1) {
    const leaseUntil = new Date(now.getTime() + intSetting("COURSE_NOTIFICATION_LEASE_SECONDS", 120, 15, 900) * 1000);
    const job = await CourseNotificationJob.findOneAndUpdate({
      $expr: { $lt: ["$attempts", "$maxAttempts"] },
      $or: [
        { status: "queued", nextRetryAt: { $lte: now } },
        { status: "processing", leaseUntil: { $lte: now } },
      ],
    }, { $set: { status: "processing", leaseUntil, lastAttemptAt: now }, $inc: { attempts: 1 } }, { new: true, sort: { nextRetryAt: 1, createdAt: 1 } }).lean();
    if (!job) break;
    try {
      const result = await deliver(job);
      if (result?.status === "sent") {
        await CourseNotificationJob.updateOne({ _id: job._id, status: "processing", leaseUntil }, { $set: { status: "sent", leaseUntil: null, lastError: "", finalFailure: false } });
        outcomes.push({ id: String(job._id), status: "sent" });
      } else if (result?.status === "not_configured") {
        await CourseNotificationJob.updateOne({ _id: job._id, status: "processing", leaseUntil }, { $set: { status: "not_configured", leaseUntil: null, lastError: "Delivery is not configured.", finalFailure: false } });
        outcomes.push({ id: String(job._id), status: "not_configured" });
      } else {
        const finalFailure = job.attempts >= job.maxAttempts;
        const delay = Math.min(24 * 60 * 60 * 1000, retryBaseMs() * (2 ** Math.min(16, job.attempts - 1)));
        await CourseNotificationJob.updateOne({ _id: job._id, status: "processing", leaseUntil }, { $set: { status: finalFailure ? "failed" : "queued", leaseUntil: null, nextRetryAt: new Date(now.getTime() + delay), lastError: genericError(result?.error), finalFailure } });
        outcomes.push({ id: String(job._id), status: finalFailure ? "failed" : "queued" });
      }
    } catch (error) {
      const finalFailure = job.attempts >= job.maxAttempts;
      const delay = Math.min(24 * 60 * 60 * 1000, retryBaseMs() * (2 ** Math.min(16, job.attempts - 1)));
      await CourseNotificationJob.updateOne({ _id: job._id, status: "processing", leaseUntil }, { $set: { status: finalFailure ? "failed" : "queued", leaseUntil: null, nextRetryAt: new Date(now.getTime() + delay), lastError: genericError(error), finalFailure } });
      outcomes.push({ id: String(job._id), status: finalFailure ? "failed" : "queued" });
    }
  }
  return outcomes;
}

export async function retryCourseNotificationsForEnrollment(enrollmentId, types) {
  const filter = { enrollmentId, status: { $in: ["failed", "not_configured", "queued"] } };
  if (types?.length) filter.type = { $in: types };
  const result = await CourseNotificationJob.updateMany(filter, { $set: { status: "queued", attempts: 0, nextRetryAt: new Date(), leaseUntil: null, finalFailure: false, lastError: "" } });
  await processCourseNotificationWorkerOnce();
  return result.modifiedCount;
}

export async function listCourseNotificationJobs({ page = 1, limit = 20, status } = {}) {
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
  const filter = {};
  if (status) {
    if (!["queued", "processing", "sent", "failed", "not_configured"].includes(status)) throw new Error("Invalid notification status.");
    filter.status = status;
  }
  const [items, total] = await Promise.all([
    CourseNotificationJob.find(filter).select("-context").populate("enrollmentId", "reference student.name courseSnapshot.title approvalStatus").sort({ createdAt: -1 }).skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
    CourseNotificationJob.countDocuments(filter),
  ]);
  return { items, pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) } };
}

export async function retryCourseNotificationJob(jobId) {
  const result = await CourseNotificationJob.updateOne({ _id: jobId, status: { $in: ["failed", "not_configured"] } }, { $set: { status: "queued", attempts: 0, nextRetryAt: new Date(), leaseUntil: null, finalFailure: false, lastError: "" } });
  if (!result.modifiedCount) return false;
  await processCourseNotificationWorkerOnce();
  return true;
}

let workerTimer;
let workerPromise;
export function startCourseNotificationWorker() {
  if (workerTimer) return;
  const run = () => {
    if (workerPromise) return workerPromise;
    workerPromise = processCourseNotificationWorkerOnce().catch(() => []).finally(() => { workerPromise = null; });
    return workerPromise;
  };
  void run();
  workerTimer = setInterval(run, intSetting("COURSE_NOTIFICATION_POLL_SECONDS", 15, 2, 300) * 1000);
  workerTimer.unref?.();
}

export async function stopCourseNotificationWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  if (workerPromise) await workerPromise;
}
