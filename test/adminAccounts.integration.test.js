import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import mongoose from "mongoose";
import Admin from "../src/modules/admin/auth/admin.model.js";
import { hashPassword } from "../src/modules/admin/auth/auth.service.js";
import { connectDatabase } from "../src/config/database.js";

/* Super Admin creates Admin / Staff accounts with a password, and every
   sign-in, failed sign-in, sign-out and account change is in the activity log. */

const DB = "projenius_admin_accounts_test";
const ORIGIN = "http://localhost:5174";
let memoryServer;
let server;
let base;

before(async () => {
  delete process.env.MONGODB_URI;
  process.env.NODE_ENV = "test";
  process.env.MONGOMS_RUNTIME_DOWNLOAD = "false";
  process.env.ADMIN_SITE_ORIGIN = ORIGIN;
  process.env.PUBLIC_SITE_ORIGIN = "http://localhost:5173";
  process.env.SESSION_SECRET = randomBytes(48).toString("hex");
  const { MongoMemoryServer } = await import("mongodb-memory-server");
  memoryServer = await MongoMemoryServer.create({ instance: { dbName: DB, ip: "127.0.0.1" } });
  process.env.MONGODB_URI = memoryServer.getUri(DB);
  process.env.MONGODB_DB_NAME = DB;
  mongoose.set("autoIndex", false);
  await connectDatabase();
  if (mongoose.connection.host !== "127.0.0.1") throw new Error("Not connected to the temporary test database.");
  const { default: app } = await import("../src/app.js");
  await Admin.createIndexes();
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});

after(async () => {
  server?.close();
  await mongoose.disconnect();
  await memoryServer?.stop();
});

const cookieOf = (response) => response.headers.get("set-cookie")?.split(";")[0] || "";

async function session() {
  const response = await fetch(`${base}/auth/csrf`, { headers: { Origin: ORIGIN } });
  return { cookie: cookieOf(response), csrf: (await response.json()).csrfToken };
}

async function call(s, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: s.cookie, "X-CSRF-Token": s.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = cookieOf(response);
  if (setCookie) s.cookie = setCookie;
  const json = await response.json().catch(() => ({}));
  if (json.csrfToken) s.csrf = json.csrfToken;
  return { status: response.status, json };
}

const sessions = new Map();
async function login(email, password, { fresh = false } = {}) {
  const key = `${email}|${password}`;
  if (!fresh && sessions.has(key)) {
    const cached = sessions.get(key);
    if ((await call(cached.s, "GET", "/auth/me")).status === 200) return cached;
  }
  const s = await session();
  const result = await call(s, "POST", "/auth/login", { email, password });
  if (result.status === 200) sessions.set(key, { s, result });
  return { s, result };
}

test("Super Admin creates staff with a password; activity is logged", async () => {
  await Admin.create({ name: "Owner", email: "owner@example.invalid", passwordHash: await hashPassword("Owner-Password-123!"), role: "superadmin" });

  const bad = await login("owner@example.invalid", "wrong-password-xx");
  assert.equal(bad.result.status, 401);
  assert.equal(bad.result.json.error, "Invalid email or password.");

  const { s: owner, result } = await login("owner@example.invalid", "Owner-Password-123!");
  assert.equal(result.status, 200);

  // Validation
  let r = await call(owner, "POST", "/admins", { name: "Short", email: "s@example.invalid", role: "staff", password: "short" });
  assert.equal(r.status, 400);
  r = await call(owner, "POST", "/admins", { name: "Bad role", email: "b@example.invalid", role: "superadmin", password: "Long-enough-pass-1" });
  assert.equal(r.status, 400);

  r = await call(owner, "POST", "/admins", { name: "Priya Staff", email: "priya@example.invalid", role: "staff", password: "Staff-Password-123" });
  assert.equal(r.status, 201);
  assert.equal(r.json.item.role, "staff");
  const staffId = r.json.item.id;

  r = await call(owner, "POST", "/admins", { name: "Dup", email: "priya@example.invalid", role: "admin", password: "Staff-Password-123" });
  assert.equal(r.status, 409);

  // Staff can sign in, but cannot manage users
  const { s: staff, result: staffLogin } = await login("priya@example.invalid", "Staff-Password-123");
  assert.equal(staffLogin.status, 200);
  assert.equal(staffLogin.json.admin.role, "staff");
  r = await call(staff, "GET", "/admins");
  assert.equal(r.status, 403);
  r = await call(staff, "POST", "/admins", { name: "X", email: "x@example.invalid", role: "admin", password: "Long-enough-pass-1" });
  assert.equal(r.status, 403);

  // Super Admin sets a new password -> staff session ends, new password works
  r = await call(owner, "PATCH", `/admins/${staffId}/password`, { password: "New-Staff-Password-9" });
  assert.equal(r.status, 200);
  r = await call(staff, "GET", "/auth/me");
  assert.equal(r.status, 401);
  assert.equal((await login("priya@example.invalid", "Staff-Password-123")).result.status, 401);
  const again = await login("priya@example.invalid", "New-Staff-Password-9");
  assert.equal(again.result.status, 200);
  r = await call(again.s, "POST", "/auth/logout");
  assert.equal(r.status, 200);

  // Role change
  r = await call(owner, "PATCH", `/admins/${staffId}/role`, { role: "admin" });
  assert.equal(r.status, 200);
  assert.equal(r.json.item.role, "admin");

  // Activity log
  r = await call(owner, "GET", "/admins/audit-logs?limit=100");
  assert.equal(r.status, 200);
  const actions = r.json.items.map((item) => item.action);
  for (const expected of ["login.failed", "login.success", "account.created", "password.set_by_superadmin", "logout", "account.role_changed"]) {
    assert.ok(actions.includes(expected), `missing ${expected}`);
  }
  const failed = r.json.items.find((item) => item.action === "login.failed" && item.metadata.email === "owner@example.invalid");
  assert.equal(failed.metadata.reason, "wrong_password");
  assert.ok(!JSON.stringify(r.json.items).includes("Staff-Password-123"), "passwords must never be logged");

  r = await call(owner, "GET", "/admins/audit-logs?category=signin&limit=100");
  assert.ok(r.json.items.every((item) => /^(login\.|logout$)/.test(item.action)));
  r = await call(owner, "GET", `/admins/audit-logs?actor=${staffId}&limit=100`);
  assert.ok(r.json.items.length > 0 && r.json.items.every((item) => String(item.actorId?._id) === staffId));

  // Unknown email failed sign-in is still recorded
  await login("nobody@example.invalid", "whatever-password");
  r = await call(owner, "GET", "/admins/audit-logs?category=signin&limit=100");
  assert.ok(r.json.items.some((item) => item.metadata?.email === "nobody@example.invalid" && item.metadata.reason === "unknown_email"));
});

test("dashboard returns only the agreed data, and hides amounts from staff", async () => {
  const Course = (await import("../src/modules/courses/course.model.js")).default;
  const day = 24 * 60 * 60 * 1000;
  await Course.collection.insertMany([
    { title: "Running course", slug: "running", status: "published", batches: [{ label: "Nov batch", status: "scheduled", startsAt: new Date(Date.now() - 5 * day), endsAt: new Date(Date.now() + 20 * day) }] },
    { title: "Finished course", slug: "finished", status: "published", batches: [{ label: "Sep batch", status: "scheduled", startsAt: new Date(Date.now() - 60 * day), endsAt: new Date(Date.now() - 10 * day) }] },
  ]);
  const apiRoot = base.replace(/\/api\/admin$/, "");
  const { s: owner } = await login("owner@example.invalid", "Owner-Password-123!");
  let response = await fetch(`${apiRoot}/api/courses/admin/dashboard`, { headers: { Cookie: owner.cookie, Origin: ORIGIN } });
  assert.equal(response.status, 200);
  let item = (await response.json()).item;
  assert.equal(item.canSeeMoney, true);
  assert.equal(item.monthly.length, 12);
  assert.equal(typeof item.totals.receivedMinor, "number");
  assert.equal(item.totals.classesOngoing, 1);
  assert.equal(item.totals.classesEnded, 1);
  assert.equal(item.classes[0].course, "Running course");

  const r = await call(owner, "POST", "/admins", { name: "Dash Staff", email: "dash@example.invalid", role: "staff", password: "Dash-Staff-Pass-1" });
  assert.equal(r.status, 201);
  const { s: staff } = await login("dash@example.invalid", "Dash-Staff-Pass-1");
  response = await fetch(`${apiRoot}/api/courses/admin/dashboard`, { headers: { Cookie: staff.cookie, Origin: ORIGIN } });
  assert.equal(response.status, 200);
  item = (await response.json()).item;
  assert.equal(item.canSeeMoney, false);
  assert.equal(item.totals.receivedMinor, undefined);
  assert.equal(item.monthly[0].receivedMinor, undefined);
});

test("dashboard shows new enquiries as notifications and counts orders", async () => {
  const Enquiry = (await import("../src/modules/contacts/enquiry.model.js")).default;
  await Enquiry.collection.insertMany([
    { referenceNumber: "PJ-ENQ-1", enquiryType: "workshop", status: "new", isRead: false, answers: { name: "Anna College" }, createdAt: new Date(), updatedAt: new Date() },
    { referenceNumber: "PJ-ENQ-2", enquiryType: "development", status: "resolved", isRead: true, answers: { name: "Old Client" }, createdAt: new Date(), updatedAt: new Date() },
  ]);
  const apiRoot = base.replace(/\/api\/admin$/, "");
  const { s: owner } = await login("owner@example.invalid", "Owner-Password-123!");
  const response = await fetch(`${apiRoot}/api/courses/admin/dashboard`, { headers: { Cookie: owner.cookie, Origin: ORIGIN } });
  const item = (await response.json()).item;
  assert.equal(item.enquiries.total, 2);
  assert.equal(item.enquiries.new, 1);
  assert.equal(item.monthly.at(-1).enquiries, 2);
  assert.deepEqual(item.notifications.map((n) => n.reference), ["PJ-ENQ-1"]);
  assert.equal(item.notifications[0].who, "Anna College");
  assert.deepEqual(item.orders, { paid: 0, failed: 0, pending: 0 });
});

test("clearing notifications hides current items for that admin only, new ones still appear", async () => {
  const Enquiry = (await import("../src/modules/contacts/enquiry.model.js")).default;
  const apiRoot = base.replace(/\/api\/admin$/, "");
  const { s: owner } = await login("owner@example.invalid", "Owner-Password-123!");
  const get = async (s) => { const body = await (await fetch(`${apiRoot}/api/courses/admin/dashboard`, { headers: { Cookie: s.cookie, Origin: ORIGIN } })).json(); return body.item; };
  assert.ok((await get(owner)).notifications.length > 0);
  const cleared = await fetch(`${apiRoot}/api/courses/admin/dashboard/notifications/clear`, { method: "POST", headers: { Cookie: owner.cookie, Origin: ORIGIN, "X-CSRF-Token": owner.csrf } });
  assert.equal(cleared.status, 200);
  const after = await get(owner);
  assert.equal(after.notifications.length, 0);
  assert.equal(after.enquiries.new, 1, "enquiry status itself is unchanged");
  await new Promise((r) => setTimeout(r, 20));
  await Enquiry.collection.insertOne({ referenceNumber: "PJ-ENQ-3", enquiryType: "course", status: "new", isRead: false, answers: { name: "Fresh Lead" }, createdAt: new Date(), updatedAt: new Date() });
  assert.deepEqual((await get(owner)).notifications.map((n) => n.reference), ["PJ-ENQ-3"]);
  const Admin = (await import("../src/modules/admin/auth/admin.model.js")).default;
  const staff = await Admin.findOne({ email: "dash@example.invalid" }).lean();
  assert.equal(staff.notificationsClearedAt, null, "another admin's bell is not cleared");
});

test("admin can retry failed enquiry emails; only the failed email is sent again", async () => {
  const Enquiry = (await import("../src/modules/contacts/enquiry.model.js")).default;
  const { setEmailTransportForTests } = await import("../src/shared/email/email.service.js");
  const [doc] = (await Enquiry.collection.insertMany([{ referenceNumber: "PJ-ENQ-RETRY", enquiryType: "general", sourcePage: "contact", status: "new", isRead: false,
    answers: { name: "Retry Person", email: "retry@example.invalid", phone: "+91 98765 43210", message: "Please call me about a project." },
    emailStatus: "failed", customerEmailStatus: "sent", adminEmailStatus: "failed", createdAt: new Date(), updatedAt: new Date() }])).insertedIds ? [await Enquiry.findOne({ referenceNumber: "PJ-ENQ-RETRY" })] : [];
  const sent = [];
  process.env.GMAIL_USER = "sender@example.invalid"; process.env.GMAIL_APP_PASSWORD = "synthetic"; process.env.ADMIN_NOTIFICATION_EMAIL = "admin@example.invalid";
  const restore = setEmailTransportForTests({ async sendMail(message) { sent.push(message.to); return { messageId: "x" }; } });
  try {
    const { s: owner } = await login("owner@example.invalid", "Owner-Password-123!");
    const r = await call(owner, "POST", `/enquiries/${doc._id}/emails/retry`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(sent, ["admin@example.invalid"], "the customer email that already went out is not sent twice");
    const after = await Enquiry.findById(doc._id).lean();
    assert.equal(after.adminEmailStatus, "sent");
    assert.equal(after.customerEmailStatus, "sent");
    assert.equal(after.emailStatus, "sent");
  } finally {
    restore(); delete process.env.GMAIL_USER; delete process.env.GMAIL_APP_PASSWORD; delete process.env.ADMIN_NOTIFICATION_EMAIL;
  }
});


test("five failed sign-ins for one email record a security alert", async () => {
  const AdminAuditEvent = (await import("../src/modules/admin/management/adminAudit.model.js")).default;
  for (let i = 0; i < 5; i += 1) {
    const { result } = await login("target@example.invalid", `wrong-password-${i}`, { fresh: true });
    assert.equal(result.status, 401);
  }
  await new Promise((r) => setTimeout(r, 200));
  const alert = await AdminAuditEvent.findOne({ action: "security.alert_sent", "metadata.email": "target@example.invalid" }).lean();
  assert.ok(alert, "an alert is recorded on the fifth failure");
  assert.equal(alert.metadata.attempts, 5);
});
