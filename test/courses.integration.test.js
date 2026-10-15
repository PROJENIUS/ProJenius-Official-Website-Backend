import assert from "node:assert/strict";
import { once } from "node:events";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import mongoose from "mongoose";

const TEST_DATABASE = "projenius_courses_integration_test";
const TEST_SECRET = "synthetic-razorpay-secret-for-tests";
const TEST_RECEIPTS = path.join(os.tmpdir(), `projenius-course-receipts-${process.pid}-${randomUUID()}`);
const TEST_UPLOADS = path.join(os.tmpdir(), `projenius-course-uploads-${process.pid}-${randomUUID()}`);
let memoryServer, appServer, endpoint, Course, Enrollment, Payment, Refund, WebhookEvent, NotificationJob, restoreGateway, restoreNotifications, restoreEmailTransport, restoreQueueRuntime, activeOrderId, notificationCalls, decisionEmails, receiptLinks, adminEmailFailuresRemaining = 0, notificationDelayMilliseconds = 0, fakePaymentStatus = "captured", fakePaymentAmount = 250000;

before(async () => {
  delete process.env.MONGODB_URI;
  delete process.env.COURSE_TERMS_VERSION;
  delete process.env.COURSE_TERMS_POLICY;
  process.env.NODE_ENV = "test";
  process.env.MONGOMS_RUNTIME_DOWNLOAD = "false";
  process.env.ADMIN_SITE_ORIGIN = "http://localhost:5174";
  process.env.SESSION_SECRET = randomBytes(48).toString("hex");
  process.env.RAZORPAY_KEY_ID = "rzp_test_synthetic";
  process.env.RAZORPAY_KEY_SECRET = TEST_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = "synthetic-webhook-secret";
  process.env.GMAIL_USER = "synthetic-sender@example.invalid";
  process.env.GMAIL_APP_PASSWORD = "synthetic-unused-password";
  process.env.ADMIN_NOTIFICATION_EMAIL = "synthetic-admin@example.invalid";
  process.env.PUBLIC_SITE_ORIGIN = "http://localhost:5173";
  process.env.PUBLIC_API_ORIGIN = "https://course-api.example.invalid";
  process.env.COURSE_RECEIPT_STORAGE_DIR = TEST_RECEIPTS;
  process.env.PRIVATE_UPLOAD_DIR = TEST_UPLOADS;
  const { MongoMemoryServer } = await import("mongodb-memory-server");
  memoryServer = await MongoMemoryServer.create({ instance: { dbName: TEST_DATABASE, ip: "127.0.0.1" } });
  const uri = memoryServer.getUri(TEST_DATABASE);
  const parsed = new URL(uri);
  if (parsed.protocol !== "mongodb:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password) throw new Error("Course tests require a credential-free loopback MongoDB instance.");
  process.env.MONGODB_URI = uri;
  const { connectDatabase } = await import("../src/config/database.js");
  await connectDatabase();
  ({ default: Course } = await import("../src/modules/courses/course.model.js"));
  ({ default: Enrollment } = await import("../src/modules/courses/courseEnrollment.model.js"));
  ({ default: Payment } = await import("../src/modules/courses/coursePayment.model.js"));
  ({ default: Refund } = await import("../src/modules/courses/courseRefund.model.js"));
  ({ default: WebhookEvent } = await import("../src/modules/courses/courseWebhookEvent.model.js"));
  ({ default: NotificationJob } = await import("../src/modules/courses/courseNotificationJob.model.js"));
  const models = await Promise.all([
    import("../src/modules/courses/courseAudit.model.js"), import("../src/modules/courses/courseRefund.model.js"), import("../src/modules/courses/courseWebhookEvent.model.js"), import("../src/modules/courses/courseReceipt.model.js"),
  ]);
  await Promise.all([Course, Enrollment, Payment, ...models.map((x) => x.default)].map((Model) => Model.createIndexes()));
  const { setRazorpayRuntimeForTests } = await import("../src/modules/courses/courses.controller.js");
  const fakeClient = {
    orders: { create: async (payload) => ({ id: `order_${randomUUID().replaceAll("-", "")}`, amount: payload.amount, currency: payload.currency }) },
    payments: { fetch: async (id) => ({ id, order_id: activeOrderId, amount: fakePaymentAmount, currency: "INR", status: fakePaymentStatus, fee: 5000 }) },
  };
  restoreGateway = setRazorpayRuntimeForTests({ keyId: "rzp_test_synthetic", client: fakeClient });
  const { setCourseNotificationRuntimeForTests } = await import("../src/modules/courses/courseNotifications.service.js");
  notificationCalls = [];
  receiptLinks = [];
  restoreNotifications = setCourseNotificationRuntimeForTests({
    async generateReceipt(details) { notificationCalls.push({ kind: "receipt", details }); return Buffer.from("synthetic PDF receipt"); },
    async sendEmails(details, channels) {
      notificationCalls.push({ kind: "email", details, channels });
      if (notificationDelayMilliseconds) await new Promise((resolve) => setTimeout(resolve, notificationDelayMilliseconds));
      const result = {};
      if (channels.customer) result.customer = { status: "sent" };
      if (channels.admin) {
        if (adminEmailFailuresRemaining) { adminEmailFailuresRemaining -= 1; result.admin = { status: "failed" }; }
        else result.admin = { status: "sent" };
      }
      return result;
    },
    async sendReceiptLink(details) { receiptLinks.push(details); return { status: "sent" }; },
  });
  decisionEmails = [];
  const { setEmailTransportForTests } = await import("../src/shared/email/email.service.js");
  restoreEmailTransport = setEmailTransportForTests({ async sendMail(message) { decisionEmails.push(message); return { messageId: "synthetic-decision-email" }; } });
  const { setCourseNotificationQueueRuntimeForTests } = await import("../src/modules/courses/courseNotificationQueue.service.js");
  restoreQueueRuntime = setCourseNotificationQueueRuntimeForTests({
    async generateReceipt(details) { notificationCalls.push({ kind: "receipt", details }); return Buffer.from("synthetic PDF receipt"); },
    async sendEmails(details, channels) {
      notificationCalls.push({ kind: "email", details, channels });
      if (notificationDelayMilliseconds) await new Promise((resolve) => setTimeout(resolve, notificationDelayMilliseconds));
      const result = {};
      if (channels.customer) result.customer = { status: "sent" };
      if (channels.admin) { if (adminEmailFailuresRemaining) { adminEmailFailuresRemaining -= 1; result.admin = { status: "failed" }; } else result.admin = { status: "sent" }; }
      return result;
    },
    async sendReceiptLink(details) { receiptLinks.push(details); return { status: "sent" }; },
    async sendScheduleEmail() { return { status: "sent" }; },
  });
  const { default: app } = await import("../src/app.js");
  appServer = app.listen(0, "127.0.0.1"); await once(appServer, "listening");
  endpoint = `http://127.0.0.1:${appServer.address().port}/api/courses`;
});

after(async () => {
  if (appServer?.listening) { appServer.closeAllConnections(); await new Promise((resolve, reject) => appServer.close((error) => error ? reject(error) : resolve())); }
  restoreGateway?.();
  restoreNotifications?.();
  restoreEmailTransport?.();
  restoreQueueRuntime?.();
  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (memoryServer) await memoryServer.stop();
  await fs.rm(TEST_RECEIPTS, { recursive: true, force: true });
  await fs.rm(TEST_UPLOADS, { recursive: true, force: true });
});

test("public catalogue, permission boundaries, checkout verification and durable publication use isolated data", async () => {
  const now = new Date();
  const base = { title: "Synthetic Course", slug: "synthetic-course", shortDescription: "Test description", description: "Synthetic only.", category: "Testing", duration: "2 weeks", deliveryMode: "online", deliveryDetails: { onlinePlatform: "Synthetic Meet", onlineJoinUrl: "https://meet.example.invalid/synthetic", onlineAccessCode: "synthetic-code" }, priceMinor: 250000, currency: "INR", status: "published", publishedAt: now, createdBy: new mongoose.Types.ObjectId(), updatedBy: new mongoose.Types.ObjectId() };
  const course = await Course.create(base);
  await Course.create({ ...base, title: "Hidden Draft", slug: "hidden-draft", status: "draft", publishedAt: null });
  let response = await fetch(endpoint);
  assert.equal(response.status, 200);
  const catalogue = await response.json();
  assert.equal(catalogue.items.length, 1);
  assert.equal(catalogue.items[0].title, base.title);
  assert.equal(catalogue.items[0].deliveryDetails, undefined, "private joining instructions are excluded from public course responses");
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const originalWarn = console.warn;
  const safeWarnings = [];
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  console.warn = (...parts) => safeWarnings.push(parts.join(" "));
  try {
    response = await fetch(endpoint);
    assert.equal(response.status, 200, "the course API remains available without webhook configuration");
    response = await fetch(`${endpoint}/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-razorpay-event-id": "evt-missing-webhook-secret" }, body: JSON.stringify({ event: "payment.captured" }) });
    assert.equal(response.status, 503, "webhook processing fails closed when its distinct secret is absent");
    assert.deepEqual(safeWarnings, ["Razorpay webhook rejected: webhook secret is not configured."]);
  } finally {
    console.warn = originalWarn;
    process.env.RAZORPAY_WEBHOOK_SECRET = webhookSecret;
  }
  response = await fetch(`${endpoint}/terms`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).item.version, "live-training-v2");
  response = await fetch(`${endpoint}/slug/hidden-draft`);
  assert.equal(response.status, 404, "unpublished course details remain private");
  response = await fetch(`${endpoint}/admin/courses`);
  assert.equal(response.status, 401, "course administration requires an authenticated session");
  const { requirePermission } = await import("../src/modules/admin/management/permissions.js");
  let deniedStatus, allowed = false;
  requirePermission("courses:publish")({ admin: { role: "admin", permissions: ["courses:list"] } }, { status(code) { deniedStatus = code; return { json() {} }; } }, () => { allowed = true; });
  assert.equal(deniedStatus, 403, "course list permission does not imply publish permission");
  assert.equal(allowed, false);
  requirePermission("courses:publish")({ admin: { role: "admin", permissions: ["courses:publish"] } }, {}, () => { allowed = true; });
  assert.equal(allowed, true, "explicit course publication permission passes the backend guard");
  const { courseCreatePermission, courseUpdatePermission } = await import("../src/modules/courses/courses.routes.js");
  assert.equal(courseCreatePermission({ title: "New course", deliveryMode: "online" }), "courses:create", "schedule-free course creation requires no schedule permission");
  assert.equal(courseCreatePermission({ batches: [] }), "courses:schedule", "legacy schedule-bearing creation still requires schedule permission");
  assert.equal(courseUpdatePermission({ title: "Updated title" }), "courses:edit");
  assert.equal(courseUpdatePermission({ batches: [] }), "courses:schedule", "batch and session changes require the separate schedule permission");
  deniedStatus = undefined; allowed = false;
  requirePermission(courseUpdatePermission({ batches: [] }))({ admin: { role: "admin", permissions: ["courses:edit"] } }, { status(code) { deniedStatus = code; return { json() {} }; } }, () => { allowed = true; });
  assert.equal(deniedStatus, 403, "course edit permission does not grant schedule-management access");

  const batchStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const scheduledCourse = await Course.create({ ...base, title: "Synthetic Batch Course", slug: "synthetic-batch-course", batches: [{ code: "october-2026", label: "October cohort", deliveryMode: "online", startsAt: batchStart, timezone: "Asia/Kolkata", registrationOpensAt: new Date(Date.now() - 60_000), registrationClosesAt: new Date(Date.now() + 60 * 60 * 1000), sessions: [{ title: "Session one", startsAt: batchStart, onlinePlatform: "Meet", onlineJoinUrl: "https://meet.example.invalid/private", onlineAccessCode: "hidden-code" }] }] });
  const batchPublicResponse = await fetch(`${endpoint}/slug/${scheduledCourse.slug}`);
  const batchPublic = await batchPublicResponse.json();
  assert.equal(batchPublicResponse.status, 200);
  assert.equal(batchPublic.item.batches, undefined, "public course detail does not expose internal batch schedules");
  assert.equal(batchPublic.item.startDate, undefined);
  assert.equal(batchPublic.item.registrationDeadline, undefined);
  const batchOrderHeaders = { "Content-Type": "application/json", "Idempotency-Key": "synthetic-batch-order-0001" };
  const batchStudent = { name: "Synthetic Batch Buyer", email: "batch@example.invalid", phone: "+1 555 010 0133" };
  response = await fetch(`${endpoint}/${scheduledCourse.id}/orders`, { method: "POST", headers: { ...batchOrderHeaders, "Idempotency-Key": "synthetic-batch-no-choice-001" }, body: JSON.stringify({ student: batchStudent, termsAccepted: true, termsVersion: "live-training-v2" }) });
  assert.equal(response.status, 201, "a course with internal scheduled batches can be purchased without choosing a schedule");
  const unscheduledOrder = await response.json();
  const unscheduledEnrollment = await Enrollment.findOne({ reference: unscheduledOrder.enrollment.reference }).lean();
  assert.equal(unscheduledEnrollment.batchId, null, "purchase is saved without selecting an internal batch");
  response = await fetch(`${endpoint}/${scheduledCourse.id}/orders`, { method: "POST", headers: batchOrderHeaders, body: JSON.stringify({ student: batchStudent, batchId: scheduledCourse.batches[0]._id, termsAccepted: true, termsVersion: "live-training-v2" }) });
  assert.equal(response.status, 201);
  const batchOrder = await response.json();
  const batchEnrollment = await Enrollment.findOne({ reference: batchOrder.enrollment.reference }).lean();
  assert.equal(String(batchEnrollment.batchId), String(scheduledCourse.batches[0]._id));
  assert.equal(batchEnrollment.batchSnapshot.code, "october-2026");

  response = await fetch(`${endpoint}/${course.id}/orders`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "synthetic-terms-denied-0001" }, body: JSON.stringify({ student: { name: "Synthetic Buyer", email: "buyer@example.invalid", phone: "+1 555 010 0123" }, termsAccepted: false, termsVersion: "live-training-v2" }) });
  assert.equal(response.status, 400, "checkout cannot start without explicit terms acceptance");

  response = await fetch(`${endpoint}/${course.id}/orders`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "synthetic-request-key-0001" }, body: JSON.stringify({ student: { name: "Synthetic Buyer", email: "buyer@example.invalid", phone: "+1 555 010 0123" }, termsAccepted: true, termsVersion: "live-training-v2" }) });
  assert.equal(response.status, 201);
  const orderData = await response.json();
  assert.equal(orderData.order.amount, base.priceMinor);
  assert.match(orderData.enrollment.reference, /^PJ-CRS-/);
  activeOrderId = orderData.order.id;
  response = await fetch(`${endpoint}/${course.id}/orders`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "synthetic-request-key-0001" }, body: JSON.stringify({ student: { name: "Synthetic Buyer", email: "buyer@example.invalid", phone: "+1 555 010 0123" }, termsAccepted: true, termsVersion: "live-training-v2" }) });
  assert.equal(response.status, 200, "a repeated idempotency key returns the original payment order");
  assert.equal((await response.json()).order.id, orderData.order.id);
  const paymentId = "pay_synthetic_capture";
  const signature = createHmac("sha256", TEST_SECRET).update(`${orderData.order.id}|${paymentId}`).digest("hex");
  response = await fetch(`${endpoint}/payments/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ razorpay_order_id: orderData.order.id, razorpay_payment_id: paymentId, razorpay_signature: signature }) });
  assert.equal(response.status, 200);
  const verifiedResponse = await response.json();
  assert.equal(verifiedResponse.status, "captured");
  assert.match(verifiedResponse.receiptUrl, /^\/api\/courses\/receipt\/[A-Za-z0-9_-]{43}$/);
  assert.equal((await Enrollment.findOne({ reference: orderData.enrollment.reference })).status, "enrolled");
  const enrolledRecord = await Enrollment.findOne({ reference: orderData.enrollment.reference });
  assert.equal(enrolledRecord.receiptStatus, "ready");
  assert.equal(enrolledRecord.customerEmailStatus, "sent");
  assert.equal(enrolledRecord.adminEmailStatus, "sent");
  assert.equal(enrolledRecord.approvalStatus, "awaiting_approval", "capture leaves registration awaiting a separate admin decision");
  assert.equal(notificationCalls.filter((x) => x.kind === "email").length, 2, "customer and admin jobs are independently stubbed after verified capture");
  let receiptResponse = await fetch(`${endpoint.replace("/api/courses", "")}${verifiedResponse.receiptUrl}`);
  assert.equal(receiptResponse.status, 200);
  assert.equal(await receiptResponse.text(), "synthetic PDF receipt");
  receiptResponse = await fetch(`${endpoint}/admin/enrollments/${enrolledRecord._id}/receipt`);
  assert.equal(receiptResponse.status, 401, "administrator receipt download remains behind authentication");
  receiptResponse = await fetch(`${endpoint.replace("/api/courses", "")}/api/courses/receipt/${"A".repeat(43)}`);
  assert.equal(receiptResponse.status, 404, "an invalid guest receipt token is denied");
  await Enrollment.updateOne({ _id: enrolledRecord._id }, { $set: { receiptTokenExpiresAt: new Date(Date.now() - 1000) } });
  receiptResponse = await fetch(`${endpoint.replace("/api/courses", "")}${verifiedResponse.receiptUrl}`);
  assert.equal(receiptResponse.status, 404, "an expired guest receipt token is denied");
  const reissueResponse = await fetch(`${endpoint}/receipt-link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reference: enrolledRecord.reference, email: enrolledRecord.student.email }) });
  assert.equal(reissueResponse.status, 202, await reissueResponse.clone().text());
  assert.equal((await reissueResponse.json()).message.includes("If the registration details match"), true);
  for (let attempt = 0; attempt < 40 && receiptLinks.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(receiptLinks.length, 1, "a matching request sends the secure replacement link through the notification stub");
  receiptResponse = await fetch(receiptLinks[0].url);
  assert.equal(receiptResponse.status, 200);
  assert.equal((await Payment.findOne({ orderId: orderData.order.id })).status, "captured");
  assert.equal((await Payment.findOne({ orderId: orderData.order.id })).gatewayFeeMinor, 5000);

  const { decideCourseEnrollment, getCourseEnrollment } = await import("../src/modules/courses/courses.controller.js");
  const invoke = async (controller, req) => {
    let status = 200, body;
    await controller(req, { status(value) { status = value; return this; }, json(value) { body = value; return this; } }, (error) => { throw error; });
    return { status, body };
  };
  const { createCourse, updateCourse } = await import("../src/modules/courses/courses.controller.js");
  const editorDraft = await invoke(createCourse, { body: { title: "Editor Draft", slug: "editor-draft", shortDescription: "Synthetic draft", description: "Created without delivery or session instructions.", category: "Testing", duration: "One week", deliveryMode: "online", priceMinor: 150000 }, admin: { id: new mongoose.Types.ObjectId().toString(), role: "admin", permissions: ["courses:create"] } });
  assert.equal(editorDraft.status, 201, "a course can be created with only the fields retained in the admin editor");
  const persistedDraft = await Course.findById(editorDraft.body.item._id).lean();
  assert.deepEqual(persistedDraft.batches, [], "new schedule-free courses get an empty schedule default");
  assert.deepEqual(persistedDraft.deliveryDetails, { onlinePlatform: "", onlineJoinUrl: "", onlineAccessCode: "", venueName: "", venueAddress: "", reportingTime: "" }, "new course private instruction fields remain empty defaults");
  const historicalCourse = await Course.create({ ...base, title: "Historical Schedule", slug: "historical-schedule", deliveryDetails: { onlinePlatform: "Historical platform", venueName: "Historical venue" }, batches: [{ code: "old-batch", label: "Old batch", deliveryMode: "online", startsAt: new Date(Date.now() + 86400000), timezone: "Asia/Kolkata", sessions: [] }] });
  const historyPreservingEdit = await invoke(updateCourse, { params: { id: String(historicalCourse._id) }, body: { title: "Historical Schedule edited" }, admin: { id: new mongoose.Types.ObjectId().toString(), role: "admin", permissions: ["courses:edit"] } });
  assert.equal(historyPreservingEdit.status, 200, "editing ordinary course fields does not require schedule permission");
  const historicalAfterEdit = await Course.findById(historicalCourse._id).lean();
  assert.equal(historicalAfterEdit.deliveryDetails.onlinePlatform, "Historical platform", "legacy private details are preserved in storage");
  assert.equal(historicalAfterEdit.batches[0].code, "old-batch", "legacy batch records are preserved in storage");
  const { default: Admin } = await import("../src/modules/admin/auth/admin.model.js");
  const { hashPassword } = await import("../src/modules/admin/auth/auth.service.js");
  const imageAdmin = await Admin.create({ name: "Synthetic Course Image Admin", email: `course-image-${randomUUID()}@example.invalid`, passwordHash: await hashPassword("Synthetic-Course-Image-Password-93!"), role: "admin", permissions: ["courses:uploadImage"] });
  const localOrigin = new URL(endpoint).origin;
  const csrf = await fetch(`${localOrigin}/api/admin/auth/csrf`, { headers: { Origin: "http://localhost:5174" } });
  assert.equal(csrf.status, 200);
  const csrfCookie = csrf.headers.get("set-cookie").split(";")[0];
  const csrfToken = (await csrf.json()).csrfToken;
  const login = await fetch(`${localOrigin}/api/admin/auth/login`, { method: "POST", headers: { Origin: "http://localhost:5174", Cookie: csrfCookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ email: imageAdmin.email, password: "Synthetic-Course-Image-Password-93!" }) });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  const sessionCookie = login.headers.get("set-cookie").split(";")[0];
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p5sAAAAASUVORK5CYII=", "base64");
  const imageForm = new FormData();
  imageForm.append("image", new Blob([imageBytes], { type: "image/png" }), "synthetic-cover.png");
  imageForm.append("alt", "Synthetic course cover");
  const imageUploadResponse = await fetch(`${endpoint}/admin/courses/${course._id}/image`, { method: "POST", headers: { Origin: "http://localhost:5174", Cookie: sessionCookie, "X-CSRF-Token": loginBody.csrfToken }, body: imageForm });
  assert.equal(imageUploadResponse.status, 200);
  const imageUpload = await imageUploadResponse.json();
  const imageFilename = imageUpload.item.filename;
  const imageMediaId = imageUpload.item.mediaId;
  assert.match(imageMediaId, /^[a-f\d]{24}$/i, "course image upload returns a stable GridFS id");
  const unauthenticatedCoursePreview = await fetch(`${endpoint}/admin/courses/${course._id}/image`);
  assert.equal(unauthenticatedCoursePreview.status, 401, "saved course covers are not exposed by the admin preview route");
  const gridfs = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "media" });
  const [gridfsFile] = await gridfs.find({ _id: new mongoose.Types.ObjectId(imageMediaId) }).toArray();
  assert.ok(gridfsFile, "the uploaded course image exists in GridFS");
  assert.equal(gridfsFile.metadata.originalFilename, "synthetic-cover.png");
  assert.equal(gridfsFile.length, imageBytes.length);
  const persistedCourse = await Course.findById(course._id).lean();
  assert.equal(persistedCourse.coverImage.filename, imageFilename);
  assert.equal(String(persistedCourse.coverImage.mediaId), imageMediaId, "the course stores the GridFS id");
  assert.equal(persistedCourse.coverImage.originalFilename, "synthetic-cover.png");
  assert.equal(persistedCourse.coverImage.size, imageBytes.length);
  assert.equal(persistedCourse.coverImage.alt, "Synthetic course cover");
  const refreshedCatalogue = await (await fetch(endpoint)).json();
  const listedCourse = refreshedCatalogue.items.find((item) => item._id === String(course._id));
  assert.equal(listedCourse.coverImage.url, `https://course-api.example.invalid/api/media/${imageMediaId}`);
  assert.doesNotMatch(listedCourse.coverImage.url, /localhost/i);
  assert.equal(listedCourse.coverImage.alt, "Synthetic course cover");
  const priorAssetOrigin = process.env.PUBLIC_API_ORIGIN;
  try {
    process.env.PUBLIC_API_ORIGIN = "http://localhost:5000";
    const localOriginCatalog = await (await fetch(endpoint)).json();
    const localOriginCourse = localOriginCatalog.items.find((item) => item._id === String(course._id));
    assert.equal(localOriginCourse.coverImage.url, `/api/media/${imageMediaId}`, "course covers use relative references instead of leaking localhost");
  } finally {
    if (priorAssetOrigin === undefined) delete process.env.PUBLIC_API_ORIGIN;
    else process.env.PUBLIC_API_ORIGIN = priorAssetOrigin;
  }
  const refreshedDetailResponse = await fetch(`${endpoint}/slug/${course.slug}`);
  const refreshedDetail = await refreshedDetailResponse.json();
  assert.equal(refreshedDetail.item.coverImage.url, listedCourse.coverImage.url);
  const adminPreview = await fetch(`${endpoint}/admin/courses/${course._id}/image`, { headers: { Cookie: sessionCookie } });
  assert.equal(adminPreview.status, 200, "an authenticated uploader can fetch the saved image preview");
  assert.equal(adminPreview.headers.get("content-type"), "image/png");
  assert.equal(adminPreview.headers.get("cross-origin-resource-policy"), "same-origin", "private admin previews retain Helmet's restrictive resource policy");
  assert.deepEqual(Buffer.from(await adminPreview.arrayBuffer()), imageBytes);
  const publicImageResponse = await fetch(`${endpoint.replace(/\/api\/courses$/, "")}/api/media/${imageMediaId}`);
  assert.equal(publicImageResponse.status, 200);
  assert.equal(publicImageResponse.headers.get("content-type"), "image/png");
  assert.equal(publicImageResponse.headers.get("cross-origin-resource-policy"), "cross-origin", "published GridFS course images may be embedded by the public website");
  const missingCourseImageResponse = await fetch(`${endpoint}/assets/${randomUUID()}.jpg`);
  assert.equal(missingCourseImageResponse.status, 404);
  assert.match(missingCourseImageResponse.headers.get("content-type"), /^text\/plain/);
  assert.deepEqual(Buffer.from(await publicImageResponse.arrayBuffer()), imageBytes, "public course image URLs resolve to the uploaded bytes");
  const legacyCourseFilename = `${randomUUID()}.png`;
  const legacyCourseBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p5sAAAAASUVORK5CYII=", "base64");
  await fs.mkdir(path.join(TEST_UPLOADS, "course_images"), { recursive: true });
  await fs.writeFile(path.join(TEST_UPLOADS, "course_images", legacyCourseFilename), legacyCourseBytes);
  await Course.create({ ...base, title: "Legacy Image Course", slug: `legacy-image-${randomUUID()}`, coverImage: { filename: legacyCourseFilename, originalFilename: "legacy.png", mimeType: "image/png", size: legacyCourseBytes.length, alt: "Legacy course cover" } });
  const legacyCourseResponse = await fetch(`${endpoint}/assets/${legacyCourseFilename}`);
  assert.equal(legacyCourseResponse.status, 200, "legacy filesystem course covers remain available");
  assert.equal(legacyCourseResponse.headers.get("content-type"), "image/png");
  assert.equal(legacyCourseResponse.headers.get("cross-origin-resource-policy"), "cross-origin", "legacy course images may be embedded by the public website");
  assert.deepEqual(Buffer.from(await legacyCourseResponse.arrayBuffer()), legacyCourseBytes);
  const { listCourseScheduleHistory } = await import("../src/modules/courses/courses.controller.js");
  const { setCourseNotificationQueueRuntimeForTests } = await import("../src/modules/courses/courseNotificationQueue.service.js");
  const scheduleDeliveries = [];
  const restoreScheduleRuntime = setCourseNotificationQueueRuntimeForTests({ async generateReceipt(details) { notificationCalls.push({ kind: "receipt", details }); return Buffer.from("synthetic PDF receipt"); }, async sendEmails(details, channels) { notificationCalls.push({ kind: "email", details, channels }); const result = {}; if (channels.customer) result.customer = { status: "sent" }; if (channels.admin) result.admin = { status: "sent" }; return result; }, async sendScheduleEmail(details) { scheduleDeliveries.push(details); return { status: "sent" }; }, async sendReceiptLink(details) { receiptLinks.push(details); return { status: "sent" }; } });
  const referencedBatch = scheduledCourse.batches[0].toObject();
  const sessionInput = referencedBatch.sessions.map((session) => ({ ...session, _id: String(session._id) }));
  const approvedScheduleEnrollment = await Enrollment.create({ reference: `PJ-CRS-SCHEDULE-${randomUUID()}`, requestKey: randomUUID(), courseId: scheduledCourse._id, batchId: scheduledCourse.batches[0]._id, batchSnapshot: { code: "october-2026", label: "October cohort", deliveryMode: "online", startsAt: batchStart, timezone: "Asia/Kolkata" }, courseSnapshot: { title: scheduledCourse.title, slug: scheduledCourse.slug, amountMinor: scheduledCourse.priceMinor, currency: "INR" }, student: { name: "Synthetic Schedule Buyer", email: "schedule@example.invalid", phone: "+1 555 010 0124" }, terms: { version: "test-v1", acceptedAt: new Date(), policy: "Synthetic terms" }, status: "enrolled", approvalStatus: "approved", approvalAt: new Date() });
  let scheduleUpdate = await invoke(updateCourse, { params: { id: String(scheduledCourse._id) }, admin: { id: new mongoose.Types.ObjectId().toString(), role: "admin", permissions: ["courses:schedule"] }, body: { batches: [{ ...referencedBatch, _id: String(referencedBatch._id), sessions: [] }] } });
  assert.equal(scheduleUpdate.status, 409, "a saved session cannot be removed after a registration references its batch");
  scheduleUpdate = await invoke(updateCourse, { params: { id: String(scheduledCourse._id) }, admin: { id: new mongoose.Types.ObjectId().toString(), role: "admin", permissions: ["courses:schedule"] }, body: { scheduleChangeReason: "Instructor availability changed.", batches: [{ ...referencedBatch, _id: String(referencedBatch._id), sessions: sessionInput.map((session) => ({ ...session, status: "cancelled" })) }] } });
  assert.equal(scheduleUpdate.status, 200, "cancelling a session preserves its identity and registration history");
  const history = await invoke(listCourseScheduleHistory, { params: { id: String(scheduledCourse._id) }, query: {} });
  assert.equal(history.status, 200);
  assert.equal(history.body.items[0].reason, "Instructor availability changed.");
  assert.equal(history.body.items[0].next[0].sessions[0].status, "cancelled");
  assert.equal(history.body.items[0].next[0].sessions[0].onlineJoinUrl, undefined, "schedule history omits private access details");
  for (let attempt = 0; attempt < 40 && scheduleDeliveries.length < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  let scheduleJob = await NotificationJob.findOne({ enrollmentId: approvedScheduleEnrollment._id, type: "cancelled" }).lean();
  assert.ok(scheduleJob, "a cancellation creates a durable notification job for approved attendees");
  assert.equal(scheduleJob.context.change.reason, "Instructor availability changed.");
  assert.equal(scheduleJob.status, "sent");
  assert.equal(scheduleDeliveries[0].cancelled, true);
  const cancelledBatch = (await Course.findById(scheduledCourse._id)).batches[0].toObject();
  const rescheduledInput = { ...cancelledBatch, _id: String(cancelledBatch._id), status: "rescheduled", sessions: cancelledBatch.sessions.map((session) => ({ ...session, _id: String(session._id), status: "rescheduled" })) };
  scheduleUpdate = await invoke(updateCourse, { params: { id: String(scheduledCourse._id) }, admin: { id: new mongoose.Types.ObjectId().toString(), role: "admin", permissions: ["courses:schedule"] }, body: { scheduleChangeReason: "A replacement instructor is confirmed.", batches: [rescheduledInput] } });
  assert.equal(scheduleUpdate.status, 200);
  for (let attempt = 0; attempt < 40 && scheduleDeliveries.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  scheduleJob = await NotificationJob.findOne({ enrollmentId: approvedScheduleEnrollment._id, type: "schedule_changed" }).lean();
  assert.ok(scheduleJob, "a reschedule creates its own durable notification job");
  assert.equal(scheduleJob.context.change.reason, "A replacement instructor is confirmed.");
  assert.equal(scheduleJob.status, "sent");
  assert.equal(scheduleDeliveries[1].cancelled, false);
  restoreScheduleRuntime();
  const actorId = new mongoose.Types.ObjectId().toString();
  await Course.updateOne({ _id: course._id }, { $unset: { deliveryDetails: 1 } });
  let decision = await invoke(getCourseEnrollment, { params: { id: String(enrolledRecord._id) }, admin: { role: "admin", permissions: [] } });
  assert.equal(decision.status, 200);
  assert.equal(decision.body.item.course.deliveryDetails, undefined, "private delivery details require course-view permission");
  decision = await invoke(decideCourseEnrollment, { params: { id: String(enrolledRecord._id) }, body: { action: "approve" }, admin: { id: actorId } });
  assert.equal(decision.status, 200);
  assert.equal(decision.body.item.approvalStatus, "approved");
  assert.equal(decision.body.item.approvalEmailStatus, "sent");
  const approvedRecord = await Enrollment.findById(enrolledRecord._id).lean();
  assert.equal(approvedRecord.status, "enrolled", "approval remains separate from captured-payment state");
  assert.equal(approvedRecord.approvalHistory[0].actorAdminId.toString(), actorId);
  assert.equal(decisionEmails[0].to, "buyer@example.invalid");
  assert.match(decisionEmails[0].text, /contact you by phone/i);
  assert.doesNotMatch(decisionEmails[0].text, /meet\.example\.invalid|synthetic-code|venue|access code/i);

  deniedStatus = 200;
  requirePermission("courses:enrollments:approve")({ admin: { role: "admin", permissions: [] } }, { status(value) { deniedStatus = value; return this; }, json() {} }, () => assert.fail("an admin without approval permission must be denied"));
  assert.equal(deniedStatus, 403);

  const webhookBody = Buffer.from(JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: paymentId, order_id: orderData.order.id, amount: base.priceMinor, currency: "INR", status: "captured" } } } }));
  const webhookSignature = createHmac("sha256", "synthetic-webhook-secret").update(webhookBody).digest("hex");
  response = await fetch(`${endpoint}/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Razorpay-Signature": "0".repeat(64), "x-razorpay-event-id": "evt-invalid-test" }, body: webhookBody });
  assert.equal(response.status, 400, "invalid raw-body webhook signatures are rejected");
  response = await fetch(`${endpoint}/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Razorpay-Signature": webhookSignature, "x-razorpay-event-id": "evt-synthetic-captured-001" }, body: webhookBody });
  assert.equal(response.status, 200);
  response = await fetch(`${endpoint}/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Razorpay-Signature": webhookSignature, "x-razorpay-event-id": "evt-synthetic-captured-001" }, body: webhookBody });
  assert.equal(response.status, 200, "duplicate signed webhook events are idempotent");
  assert.equal(await WebhookEvent.countDocuments(), 1);
  assert.equal(notificationCalls.filter((x) => x.kind === "email").length, 2, "duplicate webhook does not send duplicate customer or admin notifications");

  const refundEntity = { id: "rfnd_synthetic_001", payment_id: paymentId, amount: 25000, currency: "INR" };
  const refundPendingBody = Buffer.from(JSON.stringify({ event: "refund.created", payload: { refund: { entity: refundEntity } } }));
  const refundPendingSignature = createHmac("sha256", "synthetic-webhook-secret").update(refundPendingBody).digest("hex");
  response = await fetch(`${endpoint}/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Razorpay-Signature": refundPendingSignature, "x-razorpay-event-id": "evt-synthetic-refund-pending" }, body: refundPendingBody });
  assert.equal(response.status, 200);
  assert.equal((await Refund.findOne({ providerRefundId: refundEntity.id })).status, "pending");
  const refundProcessedBody = Buffer.from(JSON.stringify({ event: "refund.processed", payload: { refund: { entity: refundEntity } } }));
  const refundProcessedSignature = createHmac("sha256", "synthetic-webhook-secret").update(refundProcessedBody).digest("hex");
  response = await fetch(`${endpoint}/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Razorpay-Signature": refundProcessedSignature, "x-razorpay-event-id": "evt-synthetic-refund-processed" }, body: refundProcessedBody });
  assert.equal(response.status, 200);
  assert.equal((await Refund.findOne({ providerRefundId: refundEntity.id })).status, "processed");
  const refundedPayment = await Payment.findOne({ orderId: orderData.order.id }).lean();
  assert.equal(refundedPayment.refundedAmountMinor, refundEntity.amount);
  assert.equal(refundedPayment.status, "partially_refunded");

  let analyticsResponse;
  await (await import("../src/modules/courses/courses.controller.js")).courseAnalytics({ query: {} }, { json: (value) => { analyticsResponse = value; return value; } }, (error) => { throw error; });
  assert.equal(analyticsResponse.item.payments.grossCapturedMinor, base.priceMinor, "revenue counts only captured provider payments");
  assert.equal(analyticsResponse.item.payments.gatewayFeesMinor, 5000);
  assert.equal(analyticsResponse.item.courseWise.find((x) => x.slug === course.slug).capturedPayments, 1);

  response = await fetch(`${endpoint}/${course.id}/orders`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "synthetic-amount-mismatch-01" }, body: JSON.stringify({ student: { name: "Synthetic Buyer", email: "buyer@example.invalid", phone: "+1 555 010 0123" }, termsAccepted: true, termsVersion: "live-training-v2" }) });
  const mismatchOrder = await response.json(); assert.equal(response.status, 201);
  activeOrderId = mismatchOrder.order.id; fakePaymentAmount += 1;
  const mismatchSignature = createHmac("sha256", TEST_SECRET).update(`${activeOrderId}|pay_synthetic_mismatch`).digest("hex");
  response = await fetch(`${endpoint}/payments/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ razorpay_order_id: activeOrderId, razorpay_payment_id: "pay_synthetic_mismatch", razorpay_signature: mismatchSignature }) });
  assert.equal(response.status, 400, "a correctly signed but mismatched provider amount cannot enroll the student");
  assert.equal((await Enrollment.findOne({ reference: mismatchOrder.enrollment.reference })).status, "pending_payment");
  fakePaymentAmount = 250000;

  response = await fetch(`${endpoint}/${course.id}/orders`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "synthetic-authorized-state-01" }, body: JSON.stringify({ student: { name: "Pending Buyer", email: "pending@example.invalid", phone: "+1 555 010 0124" }, termsAccepted: true, termsVersion: "live-training-v2" }) });
  const pendingOrder = await response.json(); assert.equal(response.status, 201, JSON.stringify(pendingOrder));
  activeOrderId = pendingOrder.order.id; fakePaymentStatus = "authorized";
  const pendingSignature = createHmac("sha256", TEST_SECRET).update(`${activeOrderId}|pay_synthetic_pending`).digest("hex");
  response = await fetch(`${endpoint}/payments/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ razorpay_order_id: activeOrderId, razorpay_payment_id: "pay_synthetic_pending", razorpay_signature: pendingSignature }) });
  assert.equal(response.status, 202);
  assert.equal((await Enrollment.findOne({ reference: pendingOrder.enrollment.reference })).status, "pending_payment", "authorization alone does not grant enrollment");
  fakePaymentStatus = "captured";
  const retryPaymentId = "pay_synthetic_captured_after_auth";
  const retrySignature = createHmac("sha256", TEST_SECRET).update(`${activeOrderId}|${retryPaymentId}`).digest("hex");
  response = await fetch(`${endpoint}/payments/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ razorpay_order_id: activeOrderId, razorpay_payment_id: retryPaymentId, razorpay_signature: retrySignature }) });
  assert.equal(response.status, 200);
  const retryRecord = await Payment.findOne({ orderId: activeOrderId });
  assert.equal(retryRecord.status, "captured");
  assert.equal(retryRecord.attempts[0].status, "authorized", "earlier provider payment attempts remain recorded");
  assert.equal((await Enrollment.findOne({ reference: pendingOrder.enrollment.reference })).status, "enrolled");
  const pendingApprovalRecord = await Enrollment.findOne({ reference: pendingOrder.enrollment.reference });
  decision = await invoke(decideCourseEnrollment, { params: { id: String(pendingApprovalRecord._id) }, body: { action: "approve" }, admin: { id: actorId } });
  assert.equal(decision.status, 200, "registration approval does not depend on seat counters");
  assert.equal((await Enrollment.findById(pendingApprovalRecord._id)).approvalStatus, "approved");
  const rejectionEnrollment = await Enrollment.create({ reference: `PJ-CRS-TEST-${randomUUID()}`, requestKey: randomUUID(), courseId: course._id, courseSnapshot: { title: base.title, slug: base.slug, amountMinor: base.priceMinor, currency: "INR" }, student: { name: "Synthetic Reject", email: "reject@example.invalid", phone: "+1 555 010 0199" }, terms: { version: "live-training-v2", acceptedAt: now, policy: "synthetic terms" }, status: "enrolled" });
  const rejectionOrderId = `order_reject_${randomUUID()}`;
  await Payment.create({ enrollmentId: rejectionEnrollment._id, courseId: course._id, orderId: rejectionOrderId, paymentId: `pay_reject_${randomUUID()}`, amountMinor: base.priceMinor, currency: "INR", status: "captured", capturedAt: now });
  decision = await invoke(decideCourseEnrollment, { params: { id: String(rejectionEnrollment._id) }, body: { action: "reject", reason: "Synthetic policy review." }, admin: { id: actorId } });
  assert.equal(decision.status, 200);
  assert.equal(decision.body.item.approvalStatus, "rejected");
  assert.equal((await Payment.findOne({ orderId: rejectionOrderId })).status, "captured", "rejection does not fabricate a refund or erase captured payment");

  const notificationsBeforeFailedPayment = notificationCalls.filter((x) => x.kind === "email").length;
  response = await fetch(`${endpoint}/${course.id}/orders`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "synthetic-failed-payment-001" }, body: JSON.stringify({ student: { name: "Failed Buyer", email: "failed@example.invalid", phone: "+1 555 010 0125" }, termsAccepted: true, termsVersion: "live-training-v2" }) });
  const failedOrder = await response.json(); assert.equal(response.status, 201);
  activeOrderId = failedOrder.order.id; fakePaymentStatus = "failed";
  response = await fetch(`${endpoint}/payments/failure`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: activeOrderId, paymentId: "pay_synthetic_failed" }) });
  assert.equal(response.status, 200);
  assert.equal((await Enrollment.findOne({ reference: failedOrder.enrollment.reference })).status, "payment_failed");
  assert.equal(notificationCalls.filter((x) => x.kind === "email").length, notificationsBeforeFailedPayment, "failed payments do not trigger success notifications");

  response = await fetch(`${endpoint}/${course.id}/orders`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "synthetic-email-retry-0001" }, body: JSON.stringify({ student: { name: "Retry Buyer", email: "retry@example.invalid", phone: "+1 555 010 0126" }, termsAccepted: true, termsVersion: "live-training-v2" }) });
  const retryOrder = await response.json(); assert.equal(response.status, 201);
  activeOrderId = retryOrder.order.id;
  fakePaymentStatus = "captured";
  adminEmailFailuresRemaining = 1;
  const emailRetrySignature = createHmac("sha256", TEST_SECRET).update(`${activeOrderId}|pay_synthetic_email_retry`).digest("hex");
  const retryBody = JSON.stringify({ razorpay_order_id: activeOrderId, razorpay_payment_id: "pay_synthetic_email_retry", razorpay_signature: emailRetrySignature });
  response = await fetch(`${endpoint}/payments/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: retryBody });
  assert.equal(response.status, 200);
  let notificationRecord = await Enrollment.findOne({ reference: retryOrder.enrollment.reference }).lean();
  assert.equal(notificationRecord.customerEmailStatus, "sent");
  assert.equal(notificationRecord.adminEmailStatus, "failed");
  let retryJob = await NotificationJob.findOne({ enrollmentId: notificationRecord._id, type: "payment_admin" }).lean();
  assert.equal(retryJob.status, "queued", "transient provider failures are durably queued for automatic retry");
  assert.equal(retryJob.attempts, 1);
  await NotificationJob.updateOne({ _id: retryJob._id }, { $set: { nextRetryAt: new Date(Date.now() - 1000) } });
  const { processCourseNotificationWorkerOnce } = await import("../src/modules/courses/courseNotificationQueue.service.js");
  await processCourseNotificationWorkerOnce();
  retryJob = await NotificationJob.findById(retryJob._id).lean();
  assert.equal(retryJob.status, "sent", "the background worker retries eligible notification jobs");
  notificationRecord = await Enrollment.findOne({ reference: retryOrder.enrollment.reference }).lean();
  assert.equal(notificationRecord.customerEmailStatus, "sent");
  assert.equal(notificationRecord.adminEmailStatus, "sent");
  const retryEmailCalls = notificationCalls.filter((x) => x.kind === "email" && x.details.reference === retryOrder.enrollment.reference);
  assert.equal(retryEmailCalls.length, 3);
  assert.deepEqual(retryEmailCalls.map((x) => `${x.channels.customer ? "customer" : "admin"}:${x.channels.admin && x.channels.customer ? "both" : "single"}`).sort(), ["admin:single", "admin:single", "customer:single"], "customer and admin delivery are independent and successful channels are not resent");

  response = await fetch(`${endpoint}/${course.id}/orders`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "synthetic-email-concurrency-01" }, body: JSON.stringify({ student: { name: "Concurrent Buyer", email: "concurrent@example.invalid", phone: "+1 555 010 0131" }, termsAccepted: true, termsVersion: "live-training-v2" }) });
  const concurrentOrder = await response.json(); assert.equal(response.status, 201);
  activeOrderId = concurrentOrder.order.id;
  const concurrentPaymentId = "pay_synthetic_concurrent_capture";
  const concurrentSignature = createHmac("sha256", TEST_SECRET).update(`${activeOrderId}|${concurrentPaymentId}`).digest("hex");
  const concurrentBody = JSON.stringify({ razorpay_order_id: activeOrderId, razorpay_payment_id: concurrentPaymentId, razorpay_signature: concurrentSignature });
  notificationDelayMilliseconds = 50;
  const concurrentVerifications = await Promise.all([1, 2].map(() => fetch(`${endpoint}/payments/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: concurrentBody })));
  notificationDelayMilliseconds = 0;
  assert.deepEqual(concurrentVerifications.map((item) => item.status), [200, 200]);
  assert.equal(notificationCalls.filter((x) => x.kind === "email" && x.details.reference === concurrentOrder.enrollment.reference).length, 2, "atomic job claims allow both channels without duplicate sends under concurrent workers");

  response = await fetch(`${endpoint}/${course.id}/orders`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "synthetic-payment-id-reuse-01" }, body: JSON.stringify({ student: { name: "Reuse Buyer", email: "reuse@example.invalid", phone: "+1 555 010 0132" }, termsAccepted: true, termsVersion: "live-training-v2" }) });
  const reusedPaymentOrder = await response.json(); assert.equal(response.status, 201);
  activeOrderId = reusedPaymentOrder.order.id;
  const reusedSignature = createHmac("sha256", TEST_SECRET).update(`${activeOrderId}|pay_synthetic_capture`).digest("hex");
  response = await fetch(`${endpoint}/payments/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ razorpay_order_id: activeOrderId, razorpay_payment_id: "pay_synthetic_capture", razorpay_signature: reusedSignature }) });
  assert.equal(response.status, 409, "a provider payment ID already attached to another order is rejected as a conflict, not treated as success");
  assert.equal((await Enrollment.findOne({ reference: reusedPaymentOrder.enrollment.reference })).status, "pending_payment");

  const conflictingWebhookBody = Buffer.from(JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_synthetic_capture", order_id: activeOrderId, amount: base.priceMinor, currency: "INR", status: "captured" } } } }));
  const conflictingWebhookSignature = createHmac("sha256", "synthetic-webhook-secret").update(conflictingWebhookBody).digest("hex");
  response = await fetch(`${endpoint}/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Razorpay-Signature": conflictingWebhookSignature, "x-razorpay-event-id": "evt-synthetic-payment-id-conflict" }, body: conflictingWebhookBody });
  assert.equal(response.status, 409, "a signed webhook with a payment ID already owned by another order is rejected, not acknowledged as successful");
  assert.equal((await WebhookEvent.findOne({ eventId: "evt-synthetic-payment-id-conflict" })).status, "failed");

  const scheduled = await Course.create({ ...base, title: "Scheduled Synthetic Course", slug: "scheduled-synthetic-course", status: "scheduled", publishedAt: null, scheduledAt: new Date(Date.now() - 1000), scheduledBy: new mongoose.Types.ObjectId() });
  const { runCoursePublicationScan } = await import("../src/modules/courses/courseScheduler.js");
  await runCoursePublicationScan(new Date());
  assert.equal((await Course.findById(scheduled._id)).status, "published");
});

test("course payload validation rejects invalid pricing and unknown fields", async () => {
  const { validateCourseInput, CourseValidationError } = await import("../src/modules/courses/courses.validation.js");
  assert.throws(() => validateCourseInput({ title: "x", slug: "x", shortDescription: "x", description: "x", category: "x", duration: "x", deliveryMode: "online", priceMinor: 1.5 }), CourseValidationError);
  assert.throws(() => validateCourseInput({ title: "x", slug: "x", shortDescription: "x", description: "x", category: "x", duration: "x", deliveryMode: "online", priceMinor: 1, role: "superadmin" }), CourseValidationError);
  assert.throws(() => validateCourseInput({ batches: [{ code: "bad", label: "Bad batch", deliveryMode: "online", startsAt: "2026-10-15T10:00:00Z", timezone: "UTC", sessions: [{ title: "Secret", startsAt: "2026-10-15T10:00:00Z", onlineJoinUrl: "http://insecure.invalid" }] }] }, { partial: true }), CourseValidationError);
  const batchPayload = validateCourseInput({ batches: [{ code: "oct-2026", label: "October 2026", deliveryMode: "online", startsAt: "2026-10-15T10:00:00Z", timezone: "Asia/Kolkata", sessions: [{ title: "Opening session", startsAt: "2026-10-15T10:00:00Z", onlinePlatform: "Meet", onlineJoinUrl: "https://meet.example.invalid/private" }] }] }, { partial: true });
  assert.equal(batchPayload.batches[0].sessions[0].onlineJoinUrl, "https://meet.example.invalid/private");
  const deadline = validateCourseInput({ registrationDeadline: "2026-12-31", timezone: "Asia/Kolkata" }, { partial: true }).registrationDeadline;
  assert.equal(deadline.toISOString(), "2026-12-31T18:29:59.999Z", "date-only deadline remains open through the selected local day");
  assert.throws(() => validateCourseInput({ registrationDeadline: "2026-02-31" }, { partial: true }), CourseValidationError);
  assert.throws(() => validateCourseInput({ registrationDeadline: "2026-12-31", timezone: "not-a-timezone" }, { partial: true }), CourseValidationError);
});

test("course payload validation accepts structured course content and rejects unsafe resource URLs", async () => {
  const { validateCourseInput, CourseValidationError } = await import("../src/modules/courses/courses.validation.js");
  const payload = validateCourseInput({
    title: "Synthetic course", slug: "synthetic-course", shortDescription: "Synthetic short description",
    description: "Synthetic course description.", category: "Testing", duration: "Four weeks",
    deliveryMode: "online", priceMinor: 149900, listPriceMinor: 199900, level: "beginner", language: "English",
    skills: ["Problem solving"], tools: ["Python"], learningOutcomes: ["Build a project"],
    curriculum: [{ title: "Foundations", lessons: [{ title: "Lesson one", type: "reading", resourceUrl: "https://example.invalid/lesson" }] }],
    projects: [{ title: "Capstone", description: "Synthetic project", technologies: ["Python"], outcome: "Demo" }],
    faqs: [{ question: "Who is this for?", answer: "Beginners." }],
    instructor: { name: "Synthetic Instructor", expertise: ["Data"] }, certificate: { available: true, description: "Completion certificate" },
  });
  assert.equal(payload.curriculum[0].lessons[0].title, "Lesson one");
  assert.equal(payload.projects[0].title, "Capstone");
  assert.equal(payload.certificate.available, true);
  assert.throws(() => validateCourseInput({ curriculum: [{ title: "Unsafe", lessons: [{ title: "Lesson", resourceUrl: "http://example.invalid" }] }] }, { partial: true }), CourseValidationError);
  assert.throws(() => validateCourseInput({ listPriceMinor: 120000, priceMinor: 120000 }, { partial: true }), CourseValidationError);
});

test("notification worker recovers an abandoned lease and stops at its retry limit", async () => {
  const course = await Course.create({ title: "Queue test course", slug: `queue-test-${randomUUID()}`, shortDescription: "Synthetic", description: "Synthetic", category: "Test", duration: "1 day", deliveryMode: "online", priceMinor: 10000, currency: "INR", status: "published", publishedAt: new Date(), createdBy: new mongoose.Types.ObjectId(), updatedBy: new mongoose.Types.ObjectId() });
  const enrollment = await Enrollment.create({ reference: `PJ-CRS-QUEUE-${randomUUID()}`, requestKey: randomUUID(), courseId: course._id, courseSnapshot: { title: course.title, slug: course.slug, amountMinor: 10000, currency: "INR" }, student: { name: "Synthetic Queue Buyer", email: "queue@example.invalid", phone: "+1 555 010 0190" }, terms: { version: "test-v1", acceptedAt: new Date(), policy: "Synthetic terms" }, status: "enrolled", approvalStatus: "awaiting_approval" });
  await Payment.create({ enrollmentId: enrollment._id, courseId: course._id, orderId: `order_${randomUUID()}`, paymentId: `pay_${randomUUID()}`, amountMinor: 10000, currency: "INR", status: "captured", capturedAt: new Date() });
  const abandoned = await NotificationJob.create({ dedupeKey: `abandoned-${randomUUID()}`, enrollmentId: enrollment._id, courseId: course._id, type: "receipt_link", recipient: enrollment.student.email, status: "processing", attempts: 1, maxAttempts: 3, leaseUntil: new Date(Date.now() - 1000) });
  const { processCourseNotificationWorkerOnce } = await import("../src/modules/courses/courseNotificationQueue.service.js");
  await processCourseNotificationWorkerOnce();
  let recovered = await NotificationJob.findById(abandoned._id).lean();
  assert.equal(recovered.status, "sent");
  assert.equal(recovered.attempts, 2, "an expired worker lease is claimed for another bounded attempt");
  assert.equal(receiptLinks.some((item) => item.enrollment._id.equals(enrollment._id)), true);

  adminEmailFailuresRemaining = 1;
  const finalAttempt = await NotificationJob.create({ dedupeKey: `limit-${randomUUID()}`, enrollmentId: enrollment._id, courseId: course._id, type: "payment_admin", recipient: "synthetic-admin@example.invalid", status: "queued", attempts: 0, maxAttempts: 1 });
  await processCourseNotificationWorkerOnce();
  const failed = await NotificationJob.findById(finalAttempt._id).lean();
  assert.equal(failed.status, "failed");
  assert.equal(failed.finalFailure, true);
  assert.equal(failed.attempts, 1);
  await processCourseNotificationWorkerOnce();
  assert.equal((await NotificationJob.findById(finalAttempt._id)).attempts, 1, "final failures cannot exceed their configured retry limit");

  const receiptFailureEnrollment = await Enrollment.create({ reference: `PJ-CRS-PDF-${randomUUID()}`, requestKey: randomUUID(), courseId: course._id, courseSnapshot: { title: course.title, slug: course.slug, amountMinor: 10000, currency: "INR" }, student: { name: "Synthetic Receipt Buyer", email: "receipt@example.invalid", phone: "+1 555 010 0191" }, terms: { version: "test-v1", acceptedAt: new Date(), policy: "Synthetic terms" }, status: "enrolled" });
  const receiptFailurePayment = await Payment.create({ enrollmentId: receiptFailureEnrollment._id, courseId: course._id, orderId: `order_${randomUUID()}`, paymentId: `pay_${randomUUID()}`, amountMinor: 10000, currency: "INR", status: "captured", capturedAt: new Date() });
  const { enqueuePaymentNotifications } = await import("../src/modules/courses/courseNotificationQueue.service.js");
  const { setCourseNotificationRuntimeForTests } = await import("../src/modules/courses/courseNotifications.service.js");
  const failedReceiptChannels = [];
  const restoreFailedReceiptRuntime = setCourseNotificationRuntimeForTests({
    async generateReceipt() { throw new Error("Synthetic PDF generator failure."); },
    async sendEmails(_details, channels) { failedReceiptChannels.push(channels); return { customer: { status: "sent" }, admin: { status: "sent" } }; },
  });
  const { setCourseNotificationQueueRuntimeForTests } = await import("../src/modules/courses/courseNotificationQueue.service.js");
  const restoreFailedReceiptQueueRuntime = setCourseNotificationQueueRuntimeForTests({
    async generateReceipt() { throw new Error("Synthetic PDF generator failure."); },
    async sendEmails(_details, channels) { failedReceiptChannels.push(channels); return { customer: { status: "sent" }, admin: { status: "sent" } }; },
  });
  try {
    await enqueuePaymentNotifications(receiptFailureEnrollment, course, receiptFailurePayment);
    await processCourseNotificationWorkerOnce();
  } finally { restoreFailedReceiptQueueRuntime(); restoreFailedReceiptRuntime(); }
  assert.equal(failedReceiptChannels.some((channels) => channels.customer), false, "customer confirmation is not marked sent without its promised PDF receipt");
  assert.equal(failedReceiptChannels.some((channels) => channels.admin), true, "the independent admin notification can still be delivered");
  assert.equal((await NotificationJob.findOne({ enrollmentId: receiptFailureEnrollment._id, type: "payment_customer" })).status, "queued");
  assert.equal((await NotificationJob.findOne({ enrollmentId: receiptFailureEnrollment._id, type: "payment_admin" })).status, "sent");
});

test("course images require an allowed extension, MIME type and matching file signature", async () => {
  const { detectCourseImageType } = await import("../src/modules/courses/courses.controller.js");
  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x00]);
  assert.equal(detectCourseImageType({ originalname: "cover.png", mimetype: "image/png", size: png.length, buffer: png }).ext, "png");
  assert.equal(detectCourseImageType({ originalname: "cover.exe", mimetype: "image/png", size: png.length, buffer: png }), null);
  assert.equal(detectCourseImageType({ originalname: "cover.png", mimetype: "image/jpeg", size: png.length, buffer: png }), null);
  assert.equal(detectCourseImageType({ originalname: "oversized.png", mimetype: "image/png", size: 5 * 1024 * 1024 + 1, buffer: png }), null);
});

test("course lifecycle blocks publishing archived content and supports scheduled publication", async () => {
  const { canTransitionCourse } = await import("../src/modules/courses/courses.controller.js");
  assert.equal(canTransitionCourse("draft", "publish"), true);
  assert.equal(canTransitionCourse("draft", "schedule"), true);
  assert.equal(canTransitionCourse("scheduled", "schedule"), true, "scheduled dates can be rescheduled");
  assert.equal(canTransitionCourse("published", "unpublish"), true);
  assert.equal(canTransitionCourse("archived", "publish"), false);
  assert.equal(canTransitionCourse("draft", "unpublish"), false);
});

test("persisted batch and session UTC instants preserve New York daylight-saving offsets", async () => {
  const beforeJump = new Date("2026-03-08T06:30:00.000Z");
  const afterJump = new Date("2026-03-08T07:30:00.000Z");
  const course = await Course.create({
    title: "DST schedule verification", slug: `dst-schedule-${randomUUID()}`, shortDescription: "Synthetic schedule", description: "Synthetic data only", category: "Testing", duration: "One day", deliveryMode: "online", priceMinor: 10000, currency: "INR", status: "draft", createdBy: new mongoose.Types.ObjectId(), updatedBy: new mongoose.Types.ObjectId(),
    batches: [{ code: "dst-2026", label: "DST verification", deliveryMode: "online", startsAt: beforeJump, timezone: "America/New_York", sessions: [{ title: "Before spring transition", startsAt: beforeJump }, { title: "After spring transition", startsAt: afterJump }] }],
  });
  const saved = await Course.findById(course._id).lean();
  assert.equal(saved.batches[0].startsAt.toISOString(), "2026-03-08T06:30:00.000Z");
  assert.equal(saved.batches[0].sessions[0].startsAt.toISOString(), "2026-03-08T06:30:00.000Z");
  assert.equal(saved.batches[0].sessions[1].startsAt.toISOString(), "2026-03-08T07:30:00.000Z");
  assert.equal(saved.batches[0].timezone, "America/New_York");
});

test("verified course receipt generator creates a PDF for synthetic captured details", async () => {
  const { generateCourseReceipt } = await import("../src/modules/courses/courseReceipt.service.js");
  const pdf = await generateCourseReceipt({ reference: "PJ-CRS-20261014-ABCDEF1234567890", student: { name: "Synthetic Student", email: "student@example.invalid" }, courseTitle: "Synthetic Course", amountMinor: 125000, paymentId: "pay_synthetic_pdf", paidAt: new Date("2026-10-14T10:00:00Z") });
  assert.equal(Buffer.isBuffer(pdf), true);
  assert.equal(pdf.subarray(0, 4).toString("ascii"), "%PDF");
});
