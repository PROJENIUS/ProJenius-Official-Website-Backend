import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import mongoose from "mongoose";
import { ipKeyGenerator } from "express-rate-limit";
import Admin from "../src/modules/admin/auth/admin.model.js";
import { hashPassword } from "../src/modules/admin/auth/auth.service.js";
import AdminInvitation from "../src/modules/admin/auth/adminInvitation.model.js";
import PasswordReset from "../src/modules/admin/auth/passwordReset.model.js";
import { connectDatabase, DATABASE_NAME } from "../src/config/database.js";
import { DEFAULT_ADMIN_PERMISSIONS } from "../src/modules/admin/management/permissions.js";

const TEST_DATABASE_NAME = "projenius_contact_integration_test";
const VALID_MESSAGE = "Please help us understand and plan this project in more detail.";
const VALID_MOTIVATION =
  "I want to contribute to practical projects, learn from experienced teammates, and build useful technology while growing my engineering and collaboration skills.";

const validEnquiryFields = {
  startup: { stage: "Prototype", support: ["IoT"] },
  development: {
    build: ["Website / Web Application"],
    product: "New Product",
    budget: "Flexible",
  },
  workshop: { topic: ["Embedded Systems"], format: "One-Day Workshop" },
  course: { area: "IoT", level: "Beginner", mode: "Online" },
  internship: {
    department: "Computer Science",
    year: "3rd year",
    area: "Software Development",
  },
  career: { area: "Robotics", level: "Beginner", motivation: VALID_MOTIVATION },
  general: { enquiry: "General Enquiry" },
};

const temporaryUploadFiles = new Set();
const queuedNotifications = [];
const notificationState = {
  pdfCalls: [],
  emailCalls: [],
  failPdf: false,
  failEmail: false,
  adminOnlyEmailFailure: false,
};

let memoryServer;
let appServer;
let application;
let Enquiry;
let JobApplication;
let contactLimiter;
let restoreNotificationRuntime;
let uploadDirectory;
let endpoint;
let clientIp;

function makePayload(enquiryType, overrides = {}) {
  return {
    enquiryType,
    sourcePage: "contact",
    name: "Synthetic Test Applicant",
    email: `contact-${randomUUID()}@example.invalid`,
    phone: "+91 98765 43210",
    organisation: ["workshop", "internship"].includes(enquiryType)
      ? "Synthetic Test College"
      : "",
    city: "Test City",
    message: enquiryType === "career" ? "" : VALID_MESSAGE,
    enquirySpecificFields: validEnquiryFields[enquiryType],
    attachment: null,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function listUploadFiles() {
  return fs.readdir(uploadDirectory);
}

async function submit(payload, attachment) {
  const beforeNames = new Set(await listUploadFiles());
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));

  if (attachment) {
    form.append(
      "attachment",
      new Blob([attachment.bytes], { type: attachment.mimeType }),
      attachment.fileName
    );
  }

  let response;
  let body;

  try {
    response = await fetch(endpoint, { method: "POST", body: form });
    body = await response.json().catch(() => null);
  } finally {
    const afterNames = await listUploadFiles();
    for (const name of afterNames) {
      if (!beforeNames.has(name)) {
        temporaryUploadFiles.add(path.join(uploadDirectory, name));
      }
    }

    if (clientIp) {
      await contactLimiter.resetKey(ipKeyGenerator(clientIp));
    }
  }

  return { response, body };
}

async function runNextNotification() {
  const task = queuedNotifications.shift();
  assert.equal(typeof task, "function", "a post-save notification should be queued");
  await task();
}

function sessionCookie(response) {
  return response.headers.get("set-cookie")?.split(";")[0] || "";
}

async function cleanupCreatedUploads() {
  for (const filePath of temporaryUploadFiles) {
    await fs.unlink(filePath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  temporaryUploadFiles.clear();
}

before(async () => {
  // Never inherit the normal application URI; only the URI created below is used.
  delete process.env.MONGODB_URI;
  process.env.NODE_ENV = "test";
  process.env.MONGOMS_RUNTIME_DOWNLOAD = "false";
  // Exercise the same trailing-slash normalization used by CORS.
  // Reproduce the former local setting mix-up: CORS allowed the admin URL as
  // the public origin while CSRF required the website URL as the admin origin.
  process.env.ADMIN_SITE_ORIGIN = "http://localhost:5173";
  process.env.PUBLIC_SITE_ORIGIN = "http://localhost:5174";
  process.env.SESSION_SECRET = randomBytes(48).toString("hex");
  uploadDirectory = path.join(
    os.tmpdir(),
    `projenius-contact-upload-${process.pid}-${randomUUID()}`
  );
  process.env.PRIVATE_UPLOAD_DIR = uploadDirectory;
  await fs.mkdir(uploadDirectory, { recursive: false });

  const { MongoMemoryServer } = await import("mongodb-memory-server");
  memoryServer = await MongoMemoryServer.create({
    instance: {
      dbName: TEST_DATABASE_NAME,
      ip: "127.0.0.1",
    },
  });

  const localMongoUri = memoryServer.getUri(TEST_DATABASE_NAME);
  const parsedUri = new URL(localMongoUri);
  if (
    parsedUri.protocol !== "mongodb:" ||
    parsedUri.hostname !== "127.0.0.1" ||
    parsedUri.pathname !== `/${TEST_DATABASE_NAME}` ||
    parsedUri.username ||
    parsedUri.password
  ) {
    throw new Error("The temporary MongoDB target failed its localhost/test-database guard.");
  }

  process.env.MONGODB_URI = localMongoUri;
  process.env.MONGODB_DB_NAME = TEST_DATABASE_NAME;
  mongoose.set("autoIndex", false);
  await connectDatabase();

  if (
    mongoose.connection.host !== "127.0.0.1" ||
    mongoose.connection.name !== DATABASE_NAME
  ) {
    throw new Error("Mongoose did not connect to the expected temporary test database.");
  }

  // Import only the Express app; server.js loads dotenv and starts a listener.
  ({ default: application } = await import("../src/app.js"));
  ({ default: Enquiry } = await import("../src/modules/contacts/enquiry.model.js"));
  ({ default: JobApplication } = await import("../src/modules/careers/jobApplication.model.js"));
  await Promise.all([AdminInvitation.createIndexes(), PasswordReset.createIndexes(), Admin.createIndexes()]);
  ({ contactLimiter } = await import("../src/modules/contacts/enquiry.routes.js"));
  const { setNotificationRuntimeForTests } = await import(
    "../src/modules/contacts/enquiry.service.js"
  );

  restoreNotificationRuntime = setNotificationRuntimeForTests({
    schedule(callback) {
      queuedNotifications.push(callback);
    },
    async generatePdf(details) {
      notificationState.pdfCalls.push(details);
      if (notificationState.failPdf) throw new Error("Synthetic PDF failure.");
      return Buffer.from("synthetic PDF bytes");
    },
    async sendEmails(details) {
      notificationState.emailCalls.push(details);
      if (notificationState.failEmail) throw new Error("Synthetic email failure.");
      if (notificationState.adminOnlyEmailFailure) {
        return {
          customer: { status: "sent", messageId: "stub-customer" },
          admin: { status: "failed", error: "Synthetic administrator delivery failure." },
        };
      }
      return {
        customer: { status: "sent", messageId: "stub-customer" },
        admin: { status: "sent", messageId: "stub-admin" },
      };
    },
  });

  await Promise.all([Enquiry.createIndexes(), JobApplication.createIndexes()]);

  appServer = application.listen(0, "127.0.0.1");
  appServer.on("connection", (socket) => {
    clientIp = socket.remoteAddress;
  });
  await once(appServer, "listening");
  endpoint = `http://127.0.0.1:${appServer.address().port}/api/contact/enquiries`;
});

after(async () => {
  if (appServer?.listening) {
    appServer.closeAllConnections();
    await new Promise((resolve, reject) => {
      appServer.close((error) => (error ? reject(error) : resolve()));
    });
  }

  restoreNotificationRuntime?.();
  await cleanupCreatedUploads();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (memoryServer) await memoryServer.stop();
  if (uploadDirectory) await fs.rmdir(uploadDirectory).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
});

test("Contact API uses isolated persistence and deterministic notification stubs", async (t) => {
  await t.test("persists all seven enquiry choices and returns each saved reference", async () => {
    for (const enquiryType of Object.keys(validEnquiryFields)) {
      const payload = makePayload(enquiryType);
      const resume = enquiryType === "career"
        ? {
            bytes: Buffer.from("%PDF-1.4 synthetic resume"),
            fileName: "synthetic-resume.pdf",
            mimeType: "application/pdf",
          }
        : undefined;
      const { response, body } = await submit(payload, resume);

      assert.equal(response.status, 201, `${enquiryType} should be accepted`);
      assert.equal(body.success, true);
      assert.match(body.data.referenceNumber, /^PJ-(?:ENQ|JOB)-\d{8}-[A-F0-9]{8}$/);

      const Model = enquiryType === "career" ? JobApplication : Enquiry;
      const record = await Model.findOne({ referenceNumber: body.data.referenceNumber }).lean();
      assert.ok(record, `${enquiryType} record should be persisted`);
      assert.equal(record.answers.email, payload.email);
      if (enquiryType === "internship") {
        assert.equal(record.attachment, undefined, "internship resume remains optional");
      }
      assert.equal(queuedNotifications.length, 1);

      const emailsBefore = notificationState.emailCalls.length;
      await runNextNotification();
      assert.equal(notificationState.emailCalls.length, emailsBefore + 1);
      assert.equal(notificationState.emailCalls.at(-1).customerEmail, payload.email);
      assert.equal(notificationState.emailCalls.at(-1).customerEmail.endsWith(".invalid"), true);
      assert.ok(await Model.exists({ _id: record._id }), "notification processing must preserve the record");
    }
  });

  await t.test("keeps admin contact routes behind the existing authentication guard", async () => {
    const enquiriesResponse = await fetch(
      endpoint.replace("/api/contact/enquiries", "/api/admin/enquiries")
    );
    const applicationsResponse = await fetch(
      endpoint.replace("/api/contact/enquiries", "/api/admin/job-applications")
    );
    assert.equal(enquiriesResponse.status, 401);
    assert.equal(applicationsResponse.status, 401);
  });

  await t.test("admin can authenticate and persist an enquiry status update", async () => {
    const attachmentBytes = Buffer.from("%PDF-1.4 synthetic private attachment");
    const submission = await submit(makePayload("general"), {
      bytes: attachmentBytes,
      fileName: "synthetic-contact-attachment.pdf",
      mimeType: "application/pdf",
    });
    assert.equal(submission.response.status, 201);
    await runNextNotification();

    const careerSubmission = await submit(makePayload("career"), {
      bytes: Buffer.from("%PDF-1.4 synthetic private resume"),
      fileName: "synthetic-admin-resume.pdf",
      mimeType: "application/pdf",
    });
    assert.equal(careerSubmission.response.status, 201);
    await runNextNotification();

    const record = await Enquiry.findOne({
      referenceNumber: submission.body.data.referenceNumber,
    });
    assert.ok(record);
    const careerRecord = await JobApplication.findOne({
      referenceNumber: careerSubmission.body.data.referenceNumber,
    });
    assert.ok(careerRecord);

    await Admin.create({
      email: "contact-admin-test@example.invalid",
      passwordHash: await hashPassword("Synthetic-Admin-Password-Only-92!"),
      role: "superadmin",
    });

    const apiBase = endpoint.replace("/api/contact/enquiries", "");
    const adminOrigin = "http://localhost:5174";
    let response = await fetch(`${apiBase}/api/admin/auth/csrf`, {
      headers: { Origin: adminOrigin },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), adminOrigin);
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    let cookie = sessionCookie(response);
    let body = await response.json();
    assert.ok(cookie);

    response = await fetch(`${apiBase}/api/admin/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: adminOrigin,
        Cookie: cookie,
        "X-CSRF-Token": body.csrfToken,
      },
      body: JSON.stringify({
        email: "contact-admin-test@example.invalid",
        password: "Synthetic-Admin-Password-Only-92!",
      }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "Request origin not allowed.");

    // Correct the admin origin; trailing-slash normalization must still allow it.
    process.env.ADMIN_SITE_ORIGIN = `${adminOrigin}/`;

    response = await fetch(`${apiBase}/api/admin/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: adminOrigin,
        Cookie: cookie,
        "X-CSRF-Token": body.csrfToken,
      },
      body: JSON.stringify({
        email: "contact-admin-test@example.invalid",
        password: "Synthetic-Admin-Password-Only-92!",
      }),
    });
    assert.equal(response.status, 200);
    cookie = sessionCookie(response);
    body = await response.json();
    assert.ok(cookie);
    assert.equal(body.admin.email, "contact-admin-test@example.invalid");

    response = await fetch(`${apiBase}/api/admin/auth/me`, {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200, "the regenerated session should authenticate /me");
    assert.equal((await response.json()).admin.email, "contact-admin-test@example.invalid");

    // A fresh request simulates a page refresh using only the persisted cookie.
    response = await fetch(`${apiBase}/api/admin/auth/me`, {
      headers: { Cookie: cookie },
      cache: "no-store",
    });
    assert.equal(response.status, 200, "the session should persist across requests");

    const invalidCredentialsResponse = await fetch(`${apiBase}/api/admin/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: adminOrigin,
        Cookie: cookie,
        "X-CSRF-Token": body.csrfToken,
      },
      body: JSON.stringify({
        email: "contact-admin-test@example.invalid",
        password: "Wrong-Synthetic-Password-Only-92!",
      }),
    });
    assert.equal(invalidCredentialsResponse.status, 401);

    const missingCsrfResponse = await fetch(`${apiBase}/api/admin/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: adminOrigin,
        Cookie: cookie,
      },
      body: JSON.stringify({
        email: "contact-admin-test@example.invalid",
        password: "Synthetic-Admin-Password-Only-92!",
      }),
    });
    assert.equal(missingCsrfResponse.status, 403);
    assert.equal((await missingCsrfResponse.json()).error, "Invalid security token.");

    const invalidCsrfResponse = await fetch(`${apiBase}/api/admin/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: adminOrigin,
        Cookie: cookie,
        "X-CSRF-Token": "0".repeat(64),
      },
      body: JSON.stringify({
        email: "contact-admin-test@example.invalid",
        password: "Synthetic-Admin-Password-Only-92!",
      }),
    });
    assert.equal(invalidCsrfResponse.status, 403);

    const wrongOriginResponse = await fetch(`${apiBase}/api/admin/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://untrusted.example.invalid",
        Cookie: cookie,
        "X-CSRF-Token": body.csrfToken,
      },
      body: JSON.stringify({
        email: "contact-admin-test@example.invalid",
        password: "Synthetic-Admin-Password-Only-92!",
      }),
    });
    assert.equal(wrongOriginResponse.status, 403);
    assert.equal((await wrongOriginResponse.json()).error, "Request origin not allowed.");

    response = await fetch(`${apiBase}/api/admin/enquiries/${record._id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Origin: adminOrigin,
        Cookie: cookie,
        "X-CSRF-Token": body.csrfToken,
      },
      body: JSON.stringify({ status: "in_progress" }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).item.status, "in_progress");
    assert.equal((await Enquiry.findById(record._id).lean()).status, "in_progress");

    response = await fetch(`${apiBase}/api/admin/job-applications/${careerRecord._id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Origin: adminOrigin,
        Cookie: cookie,
        "X-CSRF-Token": body.csrfToken,
      },
      body: JSON.stringify({ status: "reviewing" }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).item.status, "reviewing");
    assert.equal((await JobApplication.findById(careerRecord._id).lean()).status, "reviewing");

    const receivedDay = record.createdAt.toISOString().slice(0, 10);
    response = await fetch(
      `${apiBase}/api/admin/enquiries?search=${encodeURIComponent(record.referenceNumber)}&type=general&status=in_progress&from=${receivedDay}&to=${receivedDay}&page=1&limit=1`,
      {
        headers: { Cookie: cookie },
      }
    );
    assert.equal(response.status, 200);
    const list = await response.json();
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].status, "in_progress");

    response = await fetch(
      `${apiBase}/api/admin/job-applications?search=${encodeURIComponent(careerRecord.referenceNumber)}`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(response.status, 200);
    const applicationsList = await response.json();
    assert.equal(applicationsList.items.length, 1);
    assert.equal(applicationsList.items[0].referenceNumber, careerRecord.referenceNumber);

    response = await fetch(
      `${apiBase}/api/admin/job-applications?search=${encodeURIComponent(careerRecord.referenceNumber)}&status=reviewing`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(response.status, 200);
    const reviewingApplications = await response.json();
    assert.equal(reviewingApplications.items.length, 1);
    assert.equal(reviewingApplications.pagination.total, 1);

    response = await fetch(
      `${apiBase}/api/admin/job-applications?search=${encodeURIComponent(careerRecord.referenceNumber)}&status=new`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(response.status, 200);
    const newApplications = await response.json();
    assert.equal(newApplications.items.length, 0);
    assert.equal(newApplications.pagination.total, 0);

    const filterMarker = `FILTER-${randomUUID()}`;
    const filterDate = new Date();
    const filterDateString = filterDate.toISOString().slice(0, 10);
    await Enquiry.insertMany([
      ...["closed", "closed", "new"].map((status, index) => ({
        referenceNumber: `PJ-ENQ-20261014-${randomUUID().slice(0, 8).toUpperCase()}`,
        enquiryType: "general",
        sourcePage: "integration-test",
        answers: { name: `${filterMarker}-${index}`, email: `filter-${index}@example.invalid` },
        status,
        createdAt: filterDate,
        updatedAt: filterDate,
      })),
    ]);

    const filteredEnquiriesUrl = `${apiBase}/api/admin/enquiries?search=${encodeURIComponent(filterMarker)}&type=general&from=${filterDateString}&to=${filterDateString}&page=1&limit=1`;
    response = await fetch(`${filteredEnquiriesUrl}&status=closed`, {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200);
    const closedPage = await response.json();
    assert.equal(closedPage.items.length, 1);
    assert.equal(closedPage.items[0].status, "closed");
    assert.equal(closedPage.pagination.total, 2);
    assert.equal(closedPage.pagination.pages, 2);

    response = await fetch(`${filteredEnquiriesUrl}&status=new`, {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200);
    const newPage = await response.json();
    assert.equal(newPage.items.length, 1);
    assert.equal(newPage.items[0].status, "new");
    assert.equal(newPage.pagination.total, 1);
    assert.equal(newPage.pagination.pages, 1);

    response = await fetch(filteredEnquiriesUrl, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const allStatuses = await response.json();
    assert.equal(allStatuses.pagination.total, 3);
    assert.equal(allStatuses.pagination.pages, 3);

    response = await fetch(`${apiBase}/api/admin/enquiries/${record._id}/receipt`, {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");

    response = await fetch(`${apiBase}/api/admin/enquiries/${record._id}/attachment`, {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), attachmentBytes);

    response = await fetch(`${apiBase}/api/admin/job-applications/${careerRecord._id}/resume`, {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200);
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "%PDF-1.4 synthetic private resume");
  });

  await t.test("health endpoint verifies the isolated database without returning details", async () => {
    const response = await fetch(endpoint.replace("/api/contact/enquiries", "/api/health"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", database: "available" });
  });

  await t.test("does not respond successfully or queue notifications before save completes", async () => {
    const payload = makePayload("general");
    const saveStarted = deferred();
    const allowSave = deferred();
    const originalSave = Enquiry.prototype.save;
    let responseSettled = false;

    Enquiry.prototype.save = async function (...args) {
      saveStarted.resolve();
      await allowSave.promise;
      return originalSave.apply(this, args);
    };

    const request = submit(payload).then((result) => {
      responseSettled = true;
      return result;
    });

    try {
      await saveStarted.promise;
      assert.equal(responseSettled, false);
      assert.equal(queuedNotifications.length, 0);
      allowSave.resolve();
      const { response, body } = await request;
      assert.equal(response.status, 201);
      assert.ok(await Enquiry.exists({ referenceNumber: body.data.referenceNumber }));
      assert.equal(queuedNotifications.length, 1);
      await runNextNotification();
    } finally {
      allowSave.resolve();
      Enquiry.prototype.save = originalSave;
    }
  });

  await t.test("rejects invalid regular and career payloads", async () => {
    const missingRegularField = makePayload("general", { message: "" });
    const regularResult = await submit(missingRegularField);
    assert.equal(regularResult.response.status, 400);
    assert.equal(regularResult.body.success, undefined);

    const invalidCareer = makePayload("career", {
      enquirySpecificFields: { area: "Robotics", level: "Beginner", motivation: "Too short" },
    });
    const careerResult = await submit(invalidCareer);
    assert.equal(careerResult.response.status, 400);
    assert.equal(careerResult.body.success, undefined);
    assert.equal(queuedNotifications.length, 0);
  });

  await t.test("returns failure when a database save fails", async () => {
    const payload = makePayload("startup");
    const originalSave = Enquiry.prototype.save;
    Enquiry.prototype.save = async function () {
      throw new Error("Synthetic database save failure.");
    };

    let result;
    try {
      result = await submit(payload);
    } finally {
      Enquiry.prototype.save = originalSave;
    }

    assert.equal(result.response.status, 500);
    assert.notEqual(result.body.success, true);
    assert.equal(await Enquiry.exists({ "answers.email": payload.email }), null);
    assert.equal(queuedNotifications.length, 0);
  });

  await t.test("retries a duplicate-reference race without duplicating a submission", async () => {
    const payload = makePayload("course");
    const originalSave = Enquiry.prototype.save;
    let saveAttempts = 0;
    Enquiry.prototype.save = async function () {
      saveAttempts += 1;
      if (saveAttempts === 1) {
        const error = new Error("Synthetic duplicate reference collision.");
        error.code = 11000;
        error.keyPattern = { referenceNumber: 1 };
        throw error;
      }
      return originalSave.call(this);
    };

    let result;
    try {
      result = await submit(payload);
    } finally {
      Enquiry.prototype.save = originalSave;
    }

    assert.equal(result.response.status, 201);
    assert.equal(saveAttempts, 2);
    assert.ok(await Enquiry.exists({ "answers.email": payload.email }));
    assert.equal(queuedNotifications.length, 1);
    await runNextNotification();
  });

  await t.test("accepts PDF, DOC and DOCX career resumes and persists each upload", async () => {
    const supportedResumes = [
      { fileName: "synthetic-resume.pdf", mimeType: "application/pdf" },
      { fileName: "synthetic-resume.doc", mimeType: "application/msword" },
      {
        fileName: "synthetic-resume.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    ];

    for (const resume of supportedResumes) {
      const { response, body } = await submit(makePayload("career"), {
        bytes: Buffer.from(`synthetic ${resume.fileName}`),
        ...resume,
      });

      assert.equal(response.status, 201, `${resume.fileName} should be accepted`);
      const record = await JobApplication.findOne({ referenceNumber: body.data.referenceNumber }).lean();
      assert.ok(record.resume);
      assert.equal(record.resume.originalName, resume.fileName);
      const storedPath = path.join(uploadDirectory, record.resume.storedName);
      assert.equal(await fs.stat(storedPath).then(() => true, () => false), true);
      await runNextNotification();
    }
  });

  await t.test("requires a Join Our Team resume and rejects non-document resume files", async () => {
    const savedApplicationsBefore = await JobApplication.countDocuments();
    const missingResume = await submit(makePayload("career"));
    assert.equal(missingResume.response.status, 400);
    assert.equal(
      missingResume.body.error,
      "Please upload your resume before submitting your application."
    );

    const imageResume = await submit(makePayload("career"), {
      bytes: Buffer.from("synthetic image bytes"),
      fileName: "synthetic-resume.png",
      mimeType: "image/png",
    });
    assert.equal(imageResume.response.status, 400);
    assert.match(imageResume.body.error, /resume files must be PDF, DOC or DOCX/i);

    const mismatchedResumeMime = await submit(makePayload("career"), {
      bytes: Buffer.from("synthetic image bytes"),
      fileName: "synthetic-resume.pdf",
      mimeType: "image/png",
    });
    assert.equal(mismatchedResumeMime.response.status, 400);
    assert.match(mismatchedResumeMime.body.error, /upload a PDF, DOC, DOCX/i);
    assert.equal(await JobApplication.countDocuments(), savedApplicationsBefore);
  });

  await t.test("rejects invalid uploads and removes only the failed test upload", async () => {
    const markerPath = path.join(uploadDirectory, "test-owned-keep-marker.txt");
    await fs.writeFile(markerPath, "keep this test-owned marker during request cleanup");
    temporaryUploadFiles.add(markerPath);

    const invalidPayload = makePayload("career", {
      enquirySpecificFields: { area: "Robotics", level: "Beginner", motivation: "short" },
    });
    const baselineFiles = await listUploadFiles();
    const invalidSubmission = await submit(invalidPayload, {
      bytes: Buffer.from("%PDF-1.4 synthetic invalid submission"),
      fileName: "temporary-resume.pdf",
      mimeType: "application/pdf",
    });
    assert.equal(invalidSubmission.response.status, 400);
    assert.equal(await fs.readFile(markerPath, "utf8").then(() => true), true);
    assert.deepEqual((await listUploadFiles()).sort(), baselineFiles.sort());

    const beforeInvalidFile = await listUploadFiles();
    const invalidFile = await submit(makePayload("general"), {
      bytes: Buffer.from("synthetic invalid file"),
      fileName: "invalid.exe",
      mimeType: "application/octet-stream",
    });
    assert.equal(invalidFile.response.status, 400);
    assert.deepEqual((await listUploadFiles()).sort(), beforeInvalidFile.sort());

    const beforeOversized = await listUploadFiles();
    const oversized = await submit(makePayload("general"), {
      bytes: Buffer.alloc(5 * 1024 * 1024 + 1, 1),
      fileName: "oversized.pdf",
      mimeType: "application/pdf",
    });
    assert.equal(oversized.response.status, 413);
    assert.deepEqual((await listUploadFiles()).sort(), beforeOversized.sort());

  });

  await t.test("keeps saved records and successful responses when PDF or email stubs fail", async () => {
    notificationState.failPdf = true;
    const pdfPayload = makePayload("general");
    const pdfResult = await submit(pdfPayload);
    assert.equal(pdfResult.response.status, 201);
    await runNextNotification();
    assert.ok(await Enquiry.exists({ referenceNumber: pdfResult.body.data.referenceNumber }));
    assert.equal(
      (await Enquiry.findOne({ referenceNumber: pdfResult.body.data.referenceNumber })).emailStatus,
      "failed"
    );
    notificationState.failPdf = false;

    notificationState.failEmail = true;
    const emailPayload = makePayload("career");
    const emailResult = await submit(emailPayload, {
      bytes: Buffer.from("%PDF-1.4 synthetic resume"),
      fileName: "synthetic-email-failure-resume.pdf",
      mimeType: "application/pdf",
    });
    assert.equal(emailResult.response.status, 201);
    await runNextNotification();
    assert.ok(await JobApplication.exists({ referenceNumber: emailResult.body.data.referenceNumber }));
    assert.equal(
      (await JobApplication.findOne({ referenceNumber: emailResult.body.data.referenceNumber })).emailStatus,
      "failed"
    );
    notificationState.failEmail = false;

    notificationState.adminOnlyEmailFailure = true;
    const partialPayload = makePayload("startup");
    const partialResult = await submit(partialPayload);
    assert.equal(partialResult.response.status, 201);
    await runNextNotification();
    const partialRecord = await Enquiry.findOne({
      referenceNumber: partialResult.body.data.referenceNumber,
    });
    assert.equal(partialRecord.emailStatus, "failed");
    assert.equal(partialRecord.customerEmailStatus, "sent");
    assert.equal(partialRecord.adminEmailStatus, "failed");
    assert.ok(partialRecord.customerEmailSentAt);
    assert.equal(partialRecord.adminEmailSentAt, null);
    notificationState.adminOnlyEmailFailure = false;
  });
});

test("administrator invitation and password recovery use one-time tokens and stubbed email", async () => {
  assert.equal(
    new Admin({ email: "role-default@example.invalid", passwordHash: "synthetic" }).role,
    "admin",
    "unspecified account roles must not receive superadmin privileges"
  );

  const sentMessages = [];
  const { setAuthEmailSenderForTests } = await import("../src/modules/admin/auth/authEmail.service.js");
  const restoreEmailSender = setAuthEmailSenderForTests(async (message) => {
    sentMessages.push(message);
    return { messageId: "synthetic-auth-mail" };
  });
  try {
    const apiBase = endpoint.replace("/api/contact/enquiries", "");
    const origin = "http://localhost:5174";
    const getCsrf = async () => {
      const response = await fetch(`${apiBase}/api/admin/auth/csrf`, { headers: { Origin: origin } });
      assert.equal(response.status, 200);
      return { cookie: sessionCookie(response), token: (await response.json()).csrfToken };
    };
    const post = (path, cookie, token, payload) => fetch(`${apiBase}/api/admin/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie, "X-CSRF-Token": token },
      body: JSON.stringify(payload),
    });
    const managementRequest = (path, cookie, token, method = "GET", payload) => fetch(`${apiBase}/api/admin/admins${path}`, {
      method,
      headers: {
        ...(payload ? { "Content-Type": "application/json" } : {}),
        Origin: origin,
        Cookie: cookie,
        ...(token ? { "X-CSRF-Token": token } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });

    let csrf = await getCsrf();
    let response = await post("/login", csrf.cookie, csrf.token, {
      email: "contact-admin-test@example.invalid", password: "Synthetic-Admin-Password-Only-92!",
    });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    csrf.cookie = sessionCookie(response);
    csrf.token = (await response.json()).csrfToken;
    const superAdminSession = { ...csrf };

    const selectedInvitePermissions = ["dashboard:view", "enquiries:list", "enquiries:details"];
    response = await post("/invitations", csrf.cookie, csrf.token, {
      name: "Synthetic Invited Admin", email: "synthetic-invitee@example.invalid",
      permissions: selectedInvitePermissions,
    });
    assert.equal(response.status, 202);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].to, "synthetic-invitee@example.invalid");
    const inviteToken = new URL(sentMessages[0].text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
    assert.match(inviteToken, /^[a-f0-9]{64}$/);

    response = await post("/invitations/accept", csrf.cookie, csrf.token, {
      token: inviteToken, password: "Synthetic-Invitee-Password-92!",
    });
    assert.equal(response.status, 201);
    response = await post("/invitations/accept", csrf.cookie, csrf.token, {
      token: inviteToken, password: "Synthetic-Invitee-Password-92!",
    });
    assert.equal(response.status, 400, "an invitation token is single-use");
    assert.ok(await Admin.exists({ email: "synthetic-invitee@example.invalid", role: "admin" }));
    const regularAdmin = await Admin.findOne({ email: "synthetic-invitee@example.invalid" });
    const firstInvitation = await AdminInvitation.findOne({ email: regularAdmin.email }).lean();
    assert.deepEqual(firstInvitation.permissions, selectedInvitePermissions);
    assert.deepEqual(regularAdmin.permissions, selectedInvitePermissions, "acceptance persists exactly the selected permissions");

    const invitationsBeforeInvalidPermission = await AdminInvitation.countDocuments();
    response = await post("/invitations", csrf.cookie, csrf.token, {
      name: "Synthetic Unsupported Permission",
      email: "unsupported-permission@example.invalid",
      permissions: ["courses:list"],
    });
    assert.equal(response.status, 202, "implemented course permissions can be assigned to an invited administrator");
    assert.equal(await AdminInvitation.countDocuments(), invitationsBeforeInvalidPermission + 1);

    response = await managementRequest("/?page=1&limit=20", superAdminSession.cookie);
    assert.equal(response.status, 200, "Super Admin can list accounts");
    const managementData = await response.json();
    assert.ok(managementData.items.some((item) => item.email === regularAdmin.email));
    assert.equal(managementData.items.some((item) => "passwordHash" in item), false);
    assert.equal(managementData.counts.total >= 2, true);

    response = await managementRequest(`/${regularAdmin.id}/permissions`, superAdminSession.cookie, superAdminSession.token, "PATCH", {
      permissions: ["dashboard:view", "enquiries:list", "enquiries:details"],
    });
    assert.equal(response.status, 200, "Super Admin can edit a regular Admin's permissions");
    assert.deepEqual((await Admin.findById(regularAdmin.id).lean()).permissions, ["dashboard:view", "enquiries:list", "enquiries:details"]);

    response = await post("/invitations", superAdminSession.cookie, superAdminSession.token, {
      name: "Synthetic Pending Invite",
      email: "pending-invitee@example.invalid",
    });
    assert.equal(response.status, 202);
    const defaultInvitation = await AdminInvitation.findOne({ email: "pending-invitee@example.invalid" }).lean();
    assert.deepEqual(defaultInvitation.permissions, [...DEFAULT_ADMIN_PERMISSIONS], "omitted selection uses only the documented safe baseline");
    const pendingInviteMessages = sentMessages.filter((message) => message.to === "pending-invitee@example.invalid");
    const pendingInviteToken = new URL(pendingInviteMessages[0].text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
    response = await managementRequest("/invitations?page=1&limit=20", superAdminSession.cookie);
    assert.equal(response.status, 200);
    const pendingList = await response.json();
    const pendingInvitation = pendingList.items.find((item) => item.email === "pending-invitee@example.invalid");
    assert.ok(pendingInvitation);
    assert.equal(JSON.stringify(pendingList).includes("tokenHash"), false);
    response = await managementRequest(`/invitations/${pendingInvitation._id}/resend`, superAdminSession.cookie, superAdminSession.token, "POST");
    assert.equal(response.status, 202);
    const resentMessages = sentMessages.filter((message) => message.to === "pending-invitee@example.invalid");
    const resentToken = new URL(resentMessages.at(-1).text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
    assert.notEqual(resentToken, pendingInviteToken);
    response = await post("/invitations/accept", superAdminSession.cookie, superAdminSession.token, {
      token: pendingInviteToken,
      password: "Synthetic-Pending-Password-Only-92!",
    });
    assert.equal(response.status, 400, "resending invalidates the previous setup link");

    const expiredToken = randomBytes(32).toString("hex");
    await AdminInvitation.create({
      email: "expired-invitee@example.invalid",
      name: "Synthetic Expired Invite",
      tokenHash: createHash("sha256").update(expiredToken).digest("hex"),
      invitedBy: (await Admin.findOne({ email: "contact-admin-test@example.invalid" }))._id,
      expiresAt: new Date(Date.now() - 1000),
    });
    response = await post("/invitations/accept", superAdminSession.cookie, superAdminSession.token, {
      token: expiredToken,
      password: "Synthetic-Expired-Password-Only-92!",
    });
    assert.equal(response.status, 400, "expired setup links are rejected");

    csrf = await getCsrf();
    response = await post("/login", csrf.cookie, csrf.token, {
      email: "synthetic-invitee@example.invalid", password: "Synthetic-Invitee-Password-92!",
    });
    assert.equal(response.status, 200, "invited admin can sign in");
    let loginBody = await response.json();
    csrf.cookie = sessionCookie(response);
    csrf.token = loginBody.csrfToken;
    response = await fetch(`${apiBase}/api/admin/auth/me`, { headers: { Cookie: csrf.cookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).admin.role, "admin");

    const invitationsBeforeRegularAttempt = await AdminInvitation.countDocuments();
    response = await post("/invitations", csrf.cookie, csrf.token, {
      name: "Synthetic Unauthorized Invite",
      email: "unauthorized-invitee@example.invalid",
    });
    assert.equal(response.status, 403, "regular admins cannot invite administrators");
    assert.equal(await AdminInvitation.countDocuments(), invitationsBeforeRegularAttempt);
    assert.equal(
      await Admin.exists({ email: "unauthorized-invitee@example.invalid" }),
      null
    );

    response = await managementRequest("/", csrf.cookie);
    assert.equal(response.status, 403, "regular Admin cannot list administrator accounts");
    response = await managementRequest(`/${regularAdmin.id}/permissions`, csrf.cookie, csrf.token, "PATCH", {
      permissions: ["dashboard:view", "enquiries:list", "careerApplications:list"],
    });
    assert.equal(response.status, 403, "regular Admin cannot grant itself permissions");

    response = await fetch(`${apiBase}/api/admin/enquiries`, {
      headers: { Cookie: csrf.cookie },
    });
    assert.equal(response.status, 200, "regular admins retain permitted enquiry access");
    response = await fetch(`${apiBase}/api/admin/dashboard/stats`, { headers: { Cookie: csrf.cookie } });
    assert.equal(response.status, 200, "permitted dashboard totals are available to regular Admins");
    response = await fetch(`${apiBase}/api/admin/job-applications`, {
      headers: { Cookie: csrf.cookie },
    });
    assert.equal(response.status, 403, "regular Admin cannot access an ungranted application module");

    const protectedEnquiry = await Enquiry.findOne({ attachment: { $exists: true } }).lean();
    const protectedApplication = await JobApplication.findOne({ resume: { $exists: true } }).lean();
    assert.ok(protectedEnquiry?.attachment);
    assert.ok(protectedApplication?.resume);
    response = await fetch(`${apiBase}/api/admin/enquiries/${protectedEnquiry._id}`, {
      headers: { Cookie: csrf.cookie },
    });
    assert.equal(response.status, 200, "the explicitly granted enquiry details permission works");
    response = await fetch(`${apiBase}/api/admin/job-applications/${protectedApplication._id}`, {
      headers: { Cookie: csrf.cookie },
    });
    assert.equal(response.status, 403, "ungranted career details are denied");
    response = await fetch(`${apiBase}/api/admin/enquiries/${protectedEnquiry._id}/attachment`, {
      headers: { Cookie: csrf.cookie },
    });
    assert.equal(response.status, 403, "ungranted enquiry attachment downloads are denied");
    response = await fetch(`${apiBase}/api/admin/job-applications/${protectedApplication._id}/resume`, {
      headers: { Cookie: csrf.cookie },
    });
    assert.equal(response.status, 403, "ungranted resume downloads are denied");
    response = await fetch(`${apiBase}/api/admin/enquiries/${protectedEnquiry._id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: csrf.cookie,
        "X-CSRF-Token": csrf.token,
      },
      body: JSON.stringify({ status: "in-progress" }),
    });
    assert.equal(response.status, 403, "ungranted status changes are denied");
    response = await fetch(`${apiBase}/api/admin/job-applications/${protectedApplication._id}/status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: csrf.cookie,
        "X-CSRF-Token": csrf.token,
      },
      body: JSON.stringify({ status: "reviewing" }),
    });
    assert.equal(response.status, 403, "ungranted career status changes are denied");

    response = await managementRequest(`/${regularAdmin.id}/permissions`, superAdminSession.cookie, superAdminSession.token, "PATCH", {
      permissions: ["dashboard:view"],
    });
    assert.equal(response.status, 200);
    response = await fetch(`${apiBase}/api/admin/enquiries`, { headers: { Cookie: csrf.cookie } });
    assert.equal(response.status, 403, "permission changes are enforced on the next request in an existing session");
    response = await managementRequest(`/${regularAdmin.id}/permissions`, superAdminSession.cookie, superAdminSession.token, "PATCH", {
      permissions: ["dashboard:view", "enquiries:list", "enquiries:details"],
    });
    assert.equal(response.status, 200);

    response = await managementRequest(`/${regularAdmin.id}/permissions`, csrf.cookie, csrf.token, "PATCH", {
      permissions: ["administratorManagement:manage"],
    });
    assert.equal(response.status, 403, "regular Admin cannot use the management API to self-promote");
    assert.equal(
      (await Admin.findOne({ email: "synthetic-invitee@example.invalid" }).lean()).role,
      "admin"
    );

    response = await post("/password/forgot", csrf.cookie, csrf.token, { email: "unknown@example.invalid" });
    assert.equal(response.status, 202);
    const unknownMessage = await response.json();
    response = await post("/password/forgot", csrf.cookie, csrf.token, { email: "synthetic-invitee@example.invalid" });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), unknownMessage, "password reset response must not reveal account existence");
    assert.equal(sentMessages.length, 5);
    assert.equal(sentMessages.at(-1).to, "synthetic-invitee@example.invalid");
    const resetToken = new URL(sentMessages.at(-1).text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
    assert.match(resetToken, /^[a-f0-9]{64}$/);
    assert.equal(await PasswordReset.countDocuments({ tokenHash: { $exists: true } }), 1);

    response = await post("/password/reset", csrf.cookie, csrf.token, {
      token: resetToken, password: "Synthetic-Updated-Password-93!",
    });
    assert.equal(response.status, 200);
    response = await fetch(`${apiBase}/api/admin/auth/me`, { headers: { Cookie: csrf.cookie } });
    assert.equal(response.status, 401, "password reset should invalidate existing sessions");
    csrf = await getCsrf();
    response = await post("/password/reset", csrf.cookie, csrf.token, {
      token: resetToken, password: "Synthetic-Updated-Password-93!",
    });
    assert.equal(response.status, 400, "a reset token is single-use");

    csrf = await getCsrf();
    response = await post("/login", csrf.cookie, csrf.token, {
      email: "synthetic-invitee@example.invalid", password: "Synthetic-Updated-Password-93!",
    });
    assert.equal(response.status, 200, "updated password is accepted");
    loginBody = await response.json();
    csrf.cookie = sessionCookie(response);
    csrf.token = loginBody.csrfToken;
    response = await fetch(`${apiBase}/api/admin/auth/me`, { headers: { Cookie: csrf.cookie } });
    assert.equal(response.status, 200);

    response = await managementRequest(`/${regularAdmin.id}/password-reset`, superAdminSession.cookie, superAdminSession.token, "POST");
    assert.equal(response.status, 202, "Super Admin can trigger password recovery for another account");
    const resetInitiationResponse = await response.json();
    assert.equal(JSON.stringify(resetInitiationResponse).includes("token"), false);
    assert.equal(sentMessages.at(-1).to, "synthetic-invitee@example.invalid");
    const managedResetToken = new URL(sentMessages.at(-1).text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
    response = await post("/password/reset", csrf.cookie, csrf.token, {
      token: managedResetToken,
      password: "Synthetic-Managed-Password-94!",
    });
    assert.equal(response.status, 200);
    response = await fetch(`${apiBase}/api/admin/auth/me`, { headers: { Cookie: csrf.cookie } });
    assert.equal(response.status, 401, "admin-triggered password reset revokes active sessions");

    csrf = await getCsrf();
    response = await post("/login", csrf.cookie, csrf.token, {
      email: "synthetic-invitee@example.invalid", password: "Synthetic-Managed-Password-94!",
    });
    assert.equal(response.status, 200);
    csrf.cookie = sessionCookie(response);
    csrf.token = (await response.json()).csrfToken;

    response = await managementRequest(`/${regularAdmin.id}/status`, superAdminSession.cookie, superAdminSession.token, "PATCH", { isActive: false });
    assert.equal(response.status, 200, "Super Admin can deactivate a regular account");
    response = await fetch(`${apiBase}/api/admin/auth/me`, { headers: { Cookie: csrf.cookie } });
    assert.equal(response.status, 401, "deactivation immediately revokes authenticated access");
    response = await managementRequest(`/${regularAdmin.id}/status`, superAdminSession.cookie, superAdminSession.token, "PATCH", { isActive: true });
    assert.equal(response.status, 200, "Super Admin can reactivate a regular account");

    response = await managementRequest(`/${regularAdmin.id}`, superAdminSession.cookie, superAdminSession.token, "DELETE");
    assert.equal(response.status, 200, "removal uses the reversible soft-removal path");
    assert.ok(await Admin.exists({ _id: regularAdmin._id, isActive: false, removedAt: { $ne: null } }));

    response = await managementRequest("/audit-logs?page=1&limit=100", superAdminSession.cookie);
    assert.equal(response.status, 200, "Super Admin can inspect audit history");
    const auditData = await response.json();
    const auditJson = JSON.stringify(auditData);
    assert.match(auditJson, /invitation\.created/);
    assert.match(auditJson, /permissions\.changed/);
    assert.match(auditJson, /account\.deactivated/);
    assert.match(auditJson, /account\.reactivated/);
    assert.match(auditJson, /account\.removed/);
    assert.equal(/passwordHash|tokenHash|resetToken|inviteToken/.test(auditJson), false);
    for (const secret of [inviteToken, pendingInviteToken, resentToken, resetToken, managedResetToken]) {
      assert.equal(auditJson.includes(secret), false, "audit responses must not contain invitation or reset tokens");
    }

    const superAdmin = await Admin.findOne({ email: "contact-admin-test@example.invalid" });
    const { ensureSuperAdminRemains } = await import("../src/modules/admin/management/adminManagement.controller.js");
    assert.equal(await ensureSuperAdminRemains(superAdmin), false, "the sole active Super Admin cannot be deactivated or removed");
    response = await managementRequest(`/${superAdmin.id}/status`, superAdminSession.cookie, superAdminSession.token, "PATCH", { isActive: false });
    assert.equal(response.status, 400, "a Super Admin cannot deactivate its own account");
    response = await managementRequest(`/${superAdmin.id}`, superAdminSession.cookie, superAdminSession.token, "DELETE");
    assert.equal(response.status, 400, "a Super Admin cannot remove its own account");
  } finally {
    restoreEmailSender();
  }
});
