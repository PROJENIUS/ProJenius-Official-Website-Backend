import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import test, { after, before } from "node:test";

const TEST_DATABASE = "projenius_legal_documents_test";
const ADMIN_ORIGIN = "http://localhost:5174";
const LEGACY_POLICY_KEYS = [
  "general",
  "registration",
  "subscription",
  "refunds",
  "privacy",
  "cookies",
  "delivery",
  "support",
];

let memoryServer;
let server;
let api;
let Admin;
let LegalDocument;
let CoursePolicy;
let hashPassword;

before(async () => {
  delete process.env.MONGODB_URI;
  process.env.NODE_ENV = "test";
  process.env.MONGOMS_RUNTIME_DOWNLOAD = "false";
  process.env.ADMIN_SITE_ORIGIN = ADMIN_ORIGIN;
  process.env.PUBLIC_SITE_ORIGIN = "http://localhost:5173";
  process.env.SESSION_SECRET = randomBytes(48).toString("hex");

  const { MongoMemoryServer } = await import("mongodb-memory-server");
  memoryServer = await MongoMemoryServer.create({
    instance: {
      dbName: TEST_DATABASE,
      ip: "127.0.0.1",
    },
  });
  const uri = memoryServer.getUri(TEST_DATABASE);
  const parsed = new URL(uri);
  const isIsolatedLoopbackDatabase = parsed.protocol === "mongodb:"
    && parsed.hostname === "127.0.0.1"
    && !parsed.username
    && !parsed.password;

  if (!isIsolatedLoopbackDatabase) {
    throw new Error(
      "Legal document tests require credential-free loopback MongoDB only.",
    );
  }

  process.env.MONGODB_URI = uri;
  const { connectDatabase } = await import("../src/config/database.js");
  await connectDatabase();
  ({ default: Admin } = await import("../src/modules/admin/auth/admin.model.js"));
  ({ default: LegalDocument } = await import("../src/modules/legal/legalDocument.model.js"));
  ({ default: CoursePolicy } = await import("../src/modules/courses/coursePolicy.model.js"));
  ({ hashPassword } = await import("../src/modules/admin/auth/auth.service.js"));
  await Promise.all(
    [Admin, LegalDocument, CoursePolicy].map((Model) => Model.createIndexes()),
  );

  const { default: app } = await import("../src/app.js");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  api = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));

  const mongoose = (await import("mongoose")).default;
  await mongoose.disconnect();
  await memoryServer?.stop();
  delete process.env.MONGODB_URI;
});

async function login(admin, password) {
  const tokenResponse = await fetch(`${api}/api/admin/auth/csrf`, {
    headers: { Origin: ADMIN_ORIGIN },
  });
  const cookie = tokenResponse.headers.get("set-cookie").split(";")[0];
  const { csrfToken } = await tokenResponse.json();
  const response = await fetch(`${api}/api/admin/auth/login`, {
    method: "POST",
    headers: {
      Origin: ADMIN_ORIGIN,
      Cookie: cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ email: admin.email, password }),
  });

  assert.equal(response.status, 200);
  const sessionCookie = response.headers.get("set-cookie").split(";")[0];
  const loginBody = await response.json();

  return {
    cookie: sessionCookie,
    csrfToken: loginBody.csrfToken,
  };
}

function writeHeaders(session, origin = ADMIN_ORIGIN) {
  return {
    Origin: origin,
    Cookie: session.cookie,
    "X-CSRF-Token": session.csrfToken,
    "Content-Type": "application/json",
  };
}

test("legal documents require authorization, persist edits, and preserve course terms versions", async () => {
  const preflight = await fetch(`${api}/api/legal/admin/terms`, {
    method: "OPTIONS",
    headers: {
      Origin: ADMIN_ORIGIN,
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type,x-csrf-token",
    },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-methods"), /PUT/);

  const missingPublic = await fetch(`${api}/api/legal/terms`);
  assert.equal(missingPublic.status, 200);
  const provisionalPublic = await missingPublic.json();
  assert.equal(provisionalPublic.item.isProvisional, true);
  assert.equal(provisionalPublic.item.lastUpdated, null);

  const anonymousWrite = await fetch(`${api}/api/legal/admin/terms`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(anonymousWrite.status, 401);

  const superPassword = "Synthetic-Legal-Super-Admin-834!";
  const superAdmin = await Admin.create({
    name: "Synthetic legal editor",
    email: `legal-${randomUUID()}@example.invalid`,
    passwordHash: await hashPassword(superPassword),
    role: "superadmin",
    permissions: [],
  });
  const superSession = await login(superAdmin, superPassword);
  const legacyDraft = await CoursePolicy.create({
    version: "legacy-draft-1",
    status: "draft",
    sections: LEGACY_POLICY_KEYS.map((key, order) => ({
      key,
      title: key,
      content: `Synthetic draft section ${key}`,
      order,
    })),
    createdBy: superAdmin._id,
    updatedBy: superAdmin._id,
  });

  const legacyDraftResponse = await fetch(
    `${api}/api/legal/admin/course-terms`,
    { headers: { Cookie: superSession.cookie } },
  );
  const legacyDraftBody = await legacyDraftResponse.json();
  assert.equal(legacyDraftResponse.status, 200);
  assert.equal(legacyDraftBody.item.isDraft, true);
  assert.equal(legacyDraftBody.item.sections[0].body, "Synthetic draft section general");

  const checkoutTerms = await fetch(`${api}/api/courses/terms`);
  assert.equal((await checkoutTerms.json()).item.version, "live-training-v2");
  assert.ok(await CoursePolicy.findById(legacyDraft._id));

  const starterResponse = await fetch(`${api}/api/legal/admin/terms`, {
    headers: { Cookie: superSession.cookie },
  });
  const starterBody = await starterResponse.json();
  assert.equal(starterResponse.status, 200);
  assert.equal(starterBody.item.isProvisional, true);
  assert.equal(starterBody.item.lastUpdated, null);
  assert.ok(starterBody.item.sections.length >= 14);

  const expectedTermsTopics = [
    "Introduction and acceptance",
    "Fees and payment",
    "Intellectual property",
    "Confidentiality",
    "Governing law and jurisdiction",
    "Privacy",
  ];
  for (const topic of expectedTermsTopics) {
    assert.ok(
      starterBody.item.sections.some((section) => section.heading === topic),
      `terms starter includes ${topic}`,
    );
  }

  const privacyResponse = await fetch(
    `${api}/api/legal/admin/privacy-policy`,
    { headers: { Cookie: superSession.cookie } },
  );
  const privacyStarter = await privacyResponse.json();
  const expectedPrivacyTopics = [
    "Information we handle",
    "Payments",
    "Newsletter and email",
    "Sharing",
    "Retention",
    "Children and minors",
  ];
  for (const topic of expectedPrivacyTopics) {
    assert.ok(
      privacyStarter.item.sections.some((section) => section.heading === topic),
      `privacy starter includes ${topic}`,
    );
  }

  const payload = {
    title: "Terms & Conditions",
    introduction: "Synthetic introduction for legal document integration testing.",
    sections: [
      { heading: "Acceptance", body: "Synthetic body one.", order: 0 },
      { heading: "Contact", body: "Contact teamprojenius@gmail.com.", order: 1 },
    ],
  };
  const saveResponse = await fetch(`${api}/api/legal/admin/terms`, {
    method: "PUT",
    headers: writeHeaders(superSession),
    body: JSON.stringify(payload),
  });
  assert.equal(saveResponse.status, 201);

  const saved = await saveResponse.json();
  assert.equal(saved.item.isProvisional, false);
  assert.ok(saved.item.lastUpdated);
  const initialDate = saved.item.lastUpdated;
  const dbRecord = await LegalDocument.findOne({ key: "terms" }).lean();
  assert.equal(dbRecord.title, payload.title);

  const publicResponse = await fetch(`${api}/api/legal/terms`);
  const publicBody = await publicResponse.json();
  assert.equal(publicResponse.status, 200);
  assert.equal(publicBody.item.introduction, payload.introduction);
  assert.equal(publicBody.item.isProvisional, false);
  assert.deepEqual(publicBody.item.sections.map((section) => section.order), [0, 1]);
  assert.equal("createdBy" in publicBody.item, false);
  assert.equal("updatedBy" in publicBody.item, false);
  assert.equal("revision" in publicBody.item, false);

  const unchangedResponse = await fetch(`${api}/api/legal/admin/terms`, {
    method: "PUT",
    headers: writeHeaders(superSession),
    body: JSON.stringify(payload),
  });
  const unchanged = await unchangedResponse.json();
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.item.lastUpdated, initialDate);

  const invalidPayload = await fetch(`${api}/api/legal/admin/terms`, {
    method: "PUT",
    headers: writeHeaders(superSession),
    body: JSON.stringify({ ...payload, unsupported: true }),
  });
  assert.equal(invalidPayload.status, 400);

  const invalidOrdering = await fetch(`${api}/api/legal/admin/terms`, {
    method: "PUT",
    headers: writeHeaders(superSession),
    body: JSON.stringify({
      ...payload,
      sections: [
        { ...payload.sections[0], order: 0 },
        { ...payload.sections[1], order: 4 },
      ],
    }),
  });
  assert.equal(invalidOrdering.status, 400);

  const invalidCsrf = await fetch(`${api}/api/legal/admin/terms`, {
    method: "PUT",
    headers: writeHeaders({
      ...superSession,
      csrfToken: "0".repeat(64),
    }),
    body: JSON.stringify(payload),
  });
  assert.equal(invalidCsrf.status, 403);

  const unknownKey = await fetch(`${api}/api/legal/admin/not-a-document`, {
    headers: { Cookie: superSession.cookie },
  });
  assert.equal(unknownKey.status, 404);

  const regularPassword = "Synthetic-Legal-View-Only-835!";
  const regularAdmin = await Admin.create({
    name: "Synthetic legal reader",
    email: `legal-reader-${randomUUID()}@example.invalid`,
    passwordHash: await hashPassword(regularPassword),
    role: "admin",
    permissions: ["legal:documents:view"],
  });
  const regularSession = await login(regularAdmin, regularPassword);
  const readOnlyResponse = await fetch(`${api}/api/legal/admin/terms`, {
    headers: { Cookie: regularSession.cookie },
  });
  assert.equal(readOnlyResponse.status, 200);

  const deniedWrite = await fetch(`${api}/api/legal/admin/terms`, {
    method: "PUT",
    headers: writeHeaders(regularSession),
    body: JSON.stringify(payload),
  });
  assert.equal(deniedWrite.status, 403);

  const courseTerms = {
    title: "Course Terms",
    introduction: "Synthetic course terms introduction.",
    sections: [{
      heading: "Registration",
      body: "Synthetic course terms body.",
      order: 0,
    }],
  };
  const courseSave = await fetch(`${api}/api/legal/admin/course-terms`, {
    method: "PUT",
    headers: writeHeaders(superSession),
    body: JSON.stringify(courseTerms),
  });
  assert.equal(courseSave.status, 201);

  const publicCourseResponse = await fetch(`${api}/api/courses/terms`);
  const publicCourseTerms = await publicCourseResponse.json();
  assert.equal(publicCourseTerms.item.version, "course-terms-1");
  assert.equal(publicCourseTerms.item.sections[0].content, "Synthetic course terms body.");
  assert.equal(publicCourseTerms.item.key, "course-terms");

  const updatedCourseSave = await fetch(`${api}/api/legal/admin/course-terms`, {
    method: "PUT",
    headers: writeHeaders(superSession),
    body: JSON.stringify({
      ...courseTerms,
      sections: [{
        heading: "Registration",
        body: "Updated synthetic terms.",
        order: 0,
      }],
    }),
  });
  assert.equal(updatedCourseSave.status, 200);
  assert.equal((await updatedCourseSave.json()).item.version, "course-terms-2");
  assert.equal(await LegalDocument.countDocuments({ key: "course-terms" }), 1);
  assert.equal(await LegalDocument.countDocuments({ key: "terms" }), 1);

  const legacyAdminResponse = await fetch(`${api}/api/courses/admin/policy`, {
    headers: { Cookie: superSession.cookie },
  });
  const legacyAdminRead = await legacyAdminResponse.json();
  assert.equal(legacyAdminRead.published.version, "course-terms-2");

  const legacyAdminWrite = await fetch(`${api}/api/courses/admin/policy`, {
    method: "PUT",
    headers: writeHeaders(superSession),
    body: JSON.stringify({}),
  });
  assert.equal(legacyAdminWrite.status, 409);
});
