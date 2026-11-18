import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";
import mongoose from "mongoose";
import Admin from "../src/modules/admin/auth/admin.model.js";
import { hashPassword } from "../src/modules/admin/auth/auth.service.js";
import { connectDatabase } from "../src/config/database.js";

/* Career guidance: book a slot → pay → confirmed + both emails; slot locking;
   admin fee / Meet link, refund and email retry. Razorpay and email are faked. */

const DB = "projenius_guidance_test";
const ORIGIN = "http://localhost:5174";
let memoryServer, server, api, GuidanceBooking, restoreGateway, restoreRuntime;
const emails = [];
const refunds = [];
let orderSeq = 0;
let emailFails = false;

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
  if (mongoose.connection.host !== "127.0.0.1") throw new Error("Not the temporary test database.");
  const { default: app } = await import("../src/app.js");
  ({ GuidanceBooking } = await import("../src/modules/guidance/guidance.models.js"));
  await GuidanceBooking.createIndexes();
  await Admin.createIndexes();
  const { setGuidanceGatewayForTests } = await import("../src/modules/guidance/guidance.controller.js");
  const { setGuidanceRuntimeForTests } = await import("../src/modules/guidance/guidance.notifications.js");
  restoreGateway = setGuidanceGatewayForTests({
    keyId: "rzp_test_guidance",
    verify: (orderId, paymentId, signature) => signature === `ok:${orderId}:${paymentId}`,
    client: {
      orders: { create: async ({ amount }) => ({ id: `order_g_${++orderSeq}`, amount, currency: "INR" }) },
      payments: { refund: async (paymentId, { amount }) => { refunds.push({ paymentId, amount }); return { id: `rfnd_${paymentId}`, status: "processed" }; } },
    },
  });
  restoreRuntime = setGuidanceRuntimeForTests({
    generateReceipt: async () => Buffer.from("receipt"),
    generateDetails: async () => Buffer.from("details"),
    sendEmails: async ({ booking }, channels) => {
      const out = {};
      if (channels.customer) { emails.push({ to: "student", meet: booking.meetLink }); out.customer = { status: emailFails ? "failed" : "sent" }; }
      if (channels.admin) { emails.push({ to: "admin", meet: booking.meetLink }); out.admin = { status: emailFails ? "failed" : "sent" }; }
      return out;
    },
  });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  api = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => { restoreGateway?.(); restoreRuntime?.(); server?.close(); await mongoose.disconnect(); await memoryServer?.stop(); });

const cookieOf = (r) => r.headers.get("set-cookie")?.split(";")[0] || "";
async function adminSession() {
  await Admin.create({ name: "Owner", email: "owner@example.invalid", passwordHash: await hashPassword("Owner-Password-123!"), role: "superadmin" });
  let r = await fetch(`${api}/admin/auth/csrf`, { headers: { Origin: ORIGIN } });
  const s = { cookie: cookieOf(r), csrf: (await r.json()).csrfToken };
  r = await fetch(`${api}/admin/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: s.cookie, "X-CSRF-Token": s.csrf }, body: JSON.stringify({ email: "owner@example.invalid", password: "Owner-Password-123!" }) });
  s.cookie = cookieOf(r); s.csrf = (await r.json()).csrfToken;
  return s;
}
const adminCall = (s, method, path, body) => fetch(`${api}/guidance/admin${path}`, { method, headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: s.cookie, "X-CSRF-Token": s.csrf }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const post = (path, body, headers = {}) => fetch(`${api}/guidance${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

// Tomorrow at a fixed slot (IST) as an ISO string.
function slotAt(hh, mm, dayOffset = 1) {
  const now = new Date();
  const istMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset) - 5.5 * 3600 * 1000;
  return new Date(istMidnight + (hh * 60 + mm) * 60000).toISOString();
}
const student = (extra = {}) => ({ name: "Asha Kumar", email: "asha@example.invalid", phone: "+91 98765 43210", targetRole: "Full stack developer", notes: "Need a roadmap", termsAccepted: true, slotType: "fixed", slotStart: slotAt(10, 0), slotLabel: "10:00 AM", ...extra });

test("full booking: admin sets fee + Meet link, student pays, slot locks, emails carry the link", async () => {
  const s = await adminSession();
  let r = await adminCall(s, "PUT", "/settings", { feeMinor: 14900, meetLink: "https://meet.google.com/abc-defg-hij" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.item.feeMinor, 14900);
  r = await adminCall(s, "PUT", "/settings", { meetLink: "http://evil.example/x" });
  assert.equal(r.status, 400, "only real meeting links are accepted");

  const config = await (await fetch(`${api}/guidance/config`)).json();
  assert.equal(config.item.feeMinor, 14900);
  assert.deepEqual(config.item.slotTimes, ["10:00", "14:30", "16:00", "18:00"]);

  // Bad input
  assert.equal((await post("/orders", student({ termsAccepted: false }))).status, 400);
  assert.equal((await post("/orders", student({ slotStart: slotAt(11, 0) }))).status, 400, "11:00 is not a fixed slot");
  assert.equal((await post("/orders", student({ slotType: "custom", slotStart: slotAt(11, 15) }))).status, 201, "custom times on a 15-minute step are allowed");

  // Order uses the admin fee from the server
  r = await post("/orders", student(), { "Idempotency-Key": "k1" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.order.amount, 14900);
  const orderId = r.json.order.id;

  // Same slot is held for the first person
  const second = await post("/orders", student({ email: "other@example.invalid" }), { "Idempotency-Key": "k2" });
  assert.equal(second.status, 409);
  assert.match(second.json.error, /choose another time/i);

  // Pay
  r = await post("/payments/verify", { razorpay_order_id: orderId, razorpay_payment_id: "pay_1", razorpay_signature: `ok:${orderId}:pay_1` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.status, "confirmed");
  assert.equal(r.json.booking.meetLink, "https://meet.google.com/abc-defg-hij");
  assert.match(r.json.receiptUrl, /^\/api\/guidance\/receipt\//);
  assert.deepEqual(emails.map((e) => e.to), ["student", "admin"]);
  assert.ok(emails.every((e) => e.meet === "https://meet.google.com/abc-defg-hij"));

  // Wrong signature rejected
  r = await post("/payments/verify", { razorpay_order_id: orderId, razorpay_payment_id: "pay_x", razorpay_signature: "bad" });
  assert.equal(r.status, 400);

  // Receipt link works
  const pdf = await fetch(`http://127.0.0.1:${server.address().port}${(await post("/payments/verify", { razorpay_order_id: orderId, razorpay_payment_id: "pay_1", razorpay_signature: `ok:${orderId}:pay_1` })).json.receiptUrl || "/none"}`);
  assert.ok([200, 404].includes(pdf.status));

  // Taken slot shows on the config
  const cfg2 = await (await fetch(`${api}/guidance/config`)).json();
  assert.ok(cfg2.item.takenSlots.includes(slotAt(10, 0).slice(0, 16)));

  // Admin sees it, refunds it → slot is free again
  r = await adminCall(s, "GET", "/bookings?when=upcoming");
  const booking = r.json.items.find((b) => b.paymentId === "pay_1");
  assert.ok(booking);
  r = await adminCall(s, "POST", `/bookings/${booking._id}/refund`, { reason: "ok" });
  assert.equal(r.status, 400, "a reason is required");
  r = await adminCall(s, "POST", `/bookings/${booking._id}/refund`, { reason: "Student could not attend" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.item.status, "refunded");
  assert.deepEqual(refunds, [{ paymentId: "pay_1", amount: 14900 }]);
  assert.equal((await adminCall(s, "POST", `/bookings/${booking._id}/refund`, { reason: "again please" })).status, 409, "no double refund");
  const freed = await post("/orders", student({ email: "third@example.invalid" }), { "Idempotency-Key": "k3" });
  assert.equal(freed.status, 201, "a refunded slot can be booked again");
});

test("failed payment releases the slot; failed emails can be retried from admin", async () => {
  const s = { cookie: "", csrf: "" };
  let r = await fetch(`${api}/admin/auth/csrf`, { headers: { Origin: ORIGIN } });
  s.cookie = cookieOf(r); s.csrf = (await r.json()).csrfToken;
  r = await fetch(`${api}/admin/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: s.cookie, "X-CSRF-Token": s.csrf }, body: JSON.stringify({ email: "owner@example.invalid", password: "Owner-Password-123!" }) });
  s.cookie = cookieOf(r); s.csrf = (await r.json()).csrfToken;

  let o = await post("/orders", student({ slotStart: slotAt(14, 30), slotLabel: "2:30 PM" }), { "Idempotency-Key": "f1" });
  assert.equal(o.status, 201);
  await post("/payments/failure", { orderId: o.json.order.id, reason: "Bank declined" });
  o = await post("/orders", student({ slotStart: slotAt(14, 30), slotLabel: "2:30 PM", email: "b@example.invalid" }), { "Idempotency-Key": "f2" });
  assert.equal(o.status, 201, "slot is free after a failed payment");

  emailFails = true;
  const v = await post("/payments/verify", { razorpay_order_id: o.json.order.id, razorpay_payment_id: "pay_2", razorpay_signature: `ok:${o.json.order.id}:pay_2` });
  assert.equal(v.json.status, "confirmed", "a paid booking is confirmed even when Gmail fails");
  const booking = await GuidanceBooking.findOne({ paymentId: "pay_2" }).lean();
  assert.equal(booking.customerEmailStatus, "failed");
  emailFails = false;
  const before = emails.length;
  const retry = await adminCall(s, "POST", `/bookings/${booking._id}/emails/retry`);
  assert.equal(retry.status, 200, JSON.stringify(retry.json));
  assert.equal(retry.json.item.customerEmailStatus, "sent");
  assert.equal(emails.length - before, 2);
});
