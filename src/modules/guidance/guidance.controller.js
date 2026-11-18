/* =========================================================
   PROJENIUS BACKEND — CAREER GUIDANCE CONTROLLER
   Student: pick slot → pay (Razorpay) → confirmed + emails.
   Admin: settings (fee, Meet link, slots), bookings, mark
   done / cancel, refund, retry emails.
========================================================= */

import crypto from "node:crypto";
import mongoose from "mongoose";
import { GuidanceBooking, GuidanceSettings, getGuidanceSettings } from "./guidance.models.js";
import { generateGuidanceReceipt, sendBookingEmails } from "./guidance.notifications.js";
import { getRazorpayClient, verifyPaymentSignature } from "../../shared/payments/razorpay.service.js";

const HOLD_MS = 15 * 60 * 1000;
const MAX_DAYS_AHEAD = 60;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ()-]{7,30}$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

let testGateway;
export function setGuidanceGatewayForTests(gateway) {
  if (process.env.NODE_ENV !== "test") throw new Error("Test gateway is only available in test mode.");
  const previous = testGateway;
  testGateway = gateway;
  return () => { testGateway = previous; };
}
const gateway = () => testGateway || getRazorpayClient();

const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const lockKey = (date) => new Date(date).toISOString().slice(0, 16);
const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const publicBooking = (b) => ({ reference: b.reference, status: b.status, slotStart: b.slotStart, slotLabel: b.slotLabel, amountMinor: b.amountMinor, student: { name: b.student.name, email: b.student.email }, meetLink: b.status === "confirmed" ? b.meetLink : undefined });

/* Release holds that expired without payment, so the slot can be booked again. */
async function releaseExpiredHolds(now = new Date()) {
  await GuidanceBooking.updateMany(
    { status: "pending_payment", holdExpiresAt: { $lte: now }, slotLock: { $exists: true } },
    { $unset: { slotLock: 1 } },
  );
}

// ---------- PUBLIC ----------

export async function publicGuidanceConfig(_req, res, next) {
  try {
    await releaseExpiredHolds();
    const settings = await getGuidanceSettings();
    const taken = await GuidanceBooking.find({ slotLock: { $exists: true }, slotStart: { $gte: new Date() } }).select("slotStart").lean();
    res.set("Cache-Control", "no-store");
    return res.json({ item: {
      feeMinor: settings.feeMinor, slotTimes: settings.slotTimes, callMinutes: settings.callMinutes, bookingOpen: settings.bookingOpen,
      takenSlots: taken.map((b) => lockKey(b.slotStart)),
    } });
  } catch (error) { return next(error); }
}

function validateBookingInput(body, settings) {
  const name = text(body?.name, 120), email = text(body?.email, 254).toLowerCase(), phone = text(body?.phone, 30);
  if (!name || name.length < 2) throw Object.assign(new Error("Enter your full name."), { status: 400 });
  if (!EMAIL.test(email)) throw Object.assign(new Error("Enter a valid email address."), { status: 400 });
  if (!PHONE.test(phone)) throw Object.assign(new Error("Enter a valid phone number."), { status: 400 });
  if (body?.termsAccepted !== true) throw Object.assign(new Error("Please accept the Terms & Conditions."), { status: 400 });
  const slotStart = new Date(body?.slotStart);
  if (Number.isNaN(slotStart.getTime())) throw Object.assign(new Error("Choose a date and time for the call."), { status: 400 });
  const now = Date.now();
  if (slotStart.getTime() < now + 15 * 60 * 1000) throw Object.assign(new Error("That time has passed. Please choose a later slot."), { status: 400 });
  if (slotStart.getTime() > now + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000) throw Object.assign(new Error(`Choose a date within the next ${MAX_DAYS_AHEAD} days.`), { status: 400 });
  // Fixed slots come from settings; a custom slot must be between 8 AM and 9 PM IST on a 15-minute step.
  const ist = new Date(slotStart.getTime() + 5.5 * 60 * 60 * 1000);
  const hhmm = `${String(ist.getUTCHours()).padStart(2, "0")}:${String(ist.getUTCMinutes()).padStart(2, "0")}`;
  const slotType = body?.slotType === "custom" ? "custom" : "fixed";
  if (slotType === "fixed" && !settings.slotTimes.includes(hhmm)) throw Object.assign(new Error("That time is not one of the available slots."), { status: 400 });
  if (slotType === "custom" && (ist.getUTCMinutes() % 5 !== 0 || ist.getUTCHours() < 8 || ist.getUTCHours() > 21)) throw Object.assign(new Error("Choose a custom time between 8:00 AM and 9:45 PM."), { status: 400 });
  return {
    student: { name, email, phone }, slotStart, slotType,
    slotLabel: text(body?.slotLabel, 120) || hhmm,
    targetRole: text(body?.targetRole, 160), notes: text(body?.notes, 1000),
  };
}

export async function createGuidanceOrder(req, res, next) {
  try {
    const settings = await getGuidanceSettings();
    if (!settings.bookingOpen) return res.status(409).json({ error: "Booking is closed right now. Please contact us on WhatsApp." });
    const input = validateBookingInput(req.body, settings);
    const pay = gateway();
    if (!pay) return res.status(503).json({ error: "Online payments are temporarily unavailable. No payment has been taken." });
    const requestKey = text(req.get("Idempotency-Key"), 120) || crypto.randomUUID();

    const existing = await GuidanceBooking.findOne({ requestKey }).lean();
    if (existing) {
      if (existing.status !== "pending_payment" || lockKey(existing.slotStart) !== lockKey(input.slotStart)) return res.status(409).json({ error: "Please start the booking again." });
      return res.json({ keyId: pay.keyId, order: { id: existing.orderId, amount: existing.amountMinor, currency: "INR" }, booking: { reference: existing.reference } });
    }

    await releaseExpiredHolds();
    const reference = `PJ-CG-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const order = await pay.client.orders.create({ amount: settings.feeMinor, currency: "INR", receipt: reference.slice(0, 40), notes: { kind: "career_guidance", reference } });
    try {
      await GuidanceBooking.create({
        ...input, reference, requestKey, amountMinor: settings.feeMinor, orderId: order.id, callMinutes: settings.callMinutes,
        slotLock: lockKey(input.slotStart), holdExpiresAt: new Date(Date.now() + HOLD_MS), termsAcceptedAt: new Date(),
      });
    } catch (error) {
      if (error.code === 11000 && String(error.message).includes("slot")) return res.status(409).json({ error: "Someone just booked this slot. Please choose another time." });
      throw error;
    }
    return res.status(201).json({
      keyId: pay.keyId, order: { id: order.id, amount: order.amount, currency: order.currency || "INR" }, booking: { reference },
      checkout: { name: "ProJenius", description: "1:1 Career Guidance Call", prefill: { name: input.student.name, email: input.student.email, contact: input.student.phone } },
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    return next(error);
  }
}

export async function verifyGuidancePayment(req, res, next) {
  try {
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
    const booking = await GuidanceBooking.findOne({ orderId }).lean();
    if (!booking) return res.status(404).json({ error: "Booking not found. If money was deducted, contact us with your payment ID." });
    if (!(testGateway?.verify || verifyPaymentSignature)(orderId, paymentId, signature)) return res.status(400).json({ error: "We could not verify this payment. If money was deducted, it will be refunded automatically." });

    if (booking.status !== "confirmed") {
      const settings = await getGuidanceSettings();
      const token = crypto.randomBytes(32).toString("base64url");
      const updated = await GuidanceBooking.findOneAndUpdate(
        { _id: booking._id, status: { $in: ["pending_payment", "payment_failed"] } },
        { $set: { status: "confirmed", paymentId, paidAt: new Date(), holdExpiresAt: null, slotLock: lockKey(booking.slotStart), meetLink: settings.meetLink || "", receiptTokenHash: hashToken(token), receiptTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } },
        { new: true },
      ).lean().catch((error) => { if (error.code === 11000) return "slot_taken"; throw error; });
      if (updated === "slot_taken") return res.status(409).json({ error: "This slot was taken while you were paying. Our team will call you to pick a new time or refund you.", reference: booking.reference });
      if (updated) {
        await sendBookingEmails(updated._id).catch(() => {});
        return res.json({ status: "confirmed", booking: publicBooking(updated), receiptUrl: `/api/guidance/receipt/${token}` });
      }
    }
    const fresh = await GuidanceBooking.findById(booking._id).lean();
    return res.json({ status: fresh.status, booking: publicBooking(fresh) });
  } catch (error) { return next(error); }
}

export async function recordGuidanceFailure(req, res, next) {
  try {
    const { orderId, reason } = req.body || {};
    const booking = await GuidanceBooking.findOne({ orderId, status: "pending_payment" }).lean();
    if (!booking) return res.json({ ok: true });
    await GuidanceBooking.updateOne({ _id: booking._id }, { $set: { status: "payment_failed", failureReason: text(reason, 300) }, $unset: { slotLock: 1 } });
    return res.json({ ok: true });
  } catch (error) { return next(error); }
}

export async function downloadGuidanceReceipt(req, res, next) {
  try {
    const token = String(req.params.token || "");
    if (!/^[A-Za-z0-9_-]{30,100}$/.test(token)) return res.status(404).json({ error: "Receipt not found." });
    const booking = await GuidanceBooking.findOne({ receiptTokenHash: hashToken(token), receiptTokenExpiresAt: { $gt: new Date() } }).lean();
    if (!booking) return res.status(404).json({ error: "This receipt link has expired. Check your email for the receipt." });
    const pdf = await generateGuidanceReceipt(booking);
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="ProJenius-Guidance-Receipt-${booking.reference}.pdf"`, "Cache-Control": "no-store" });
    return res.send(pdf);
  } catch (error) { return next(error); }
}

// ---------- ADMIN ----------

export async function adminGetGuidanceSettings(_req, res, next) {
  try { return res.json({ item: await getGuidanceSettings() }); } catch (error) { return next(error); }
}

export async function adminSaveGuidanceSettings(req, res, next) {
  try {
    const body = req.body || {};
    const set = { updatedBy: req.admin.id };
    if (body.feeMinor !== undefined) {
      if (!Number.isSafeInteger(body.feeMinor) || body.feeMinor < 100 || body.feeMinor > 10000000) return res.status(400).json({ error: "Enter a fee of at least ₹1." });
      set.feeMinor = body.feeMinor;
    }
    if (body.meetLink !== undefined) {
      const link = text(body.meetLink, 300);
      if (link && !/^https:\/\/(meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com)\//i.test(link)) return res.status(400).json({ error: "Paste a Google Meet (or Zoom / Teams) link starting with https://" });
      set.meetLink = link;
    }
    if (body.slotTimes !== undefined) {
      if (!Array.isArray(body.slotTimes) || !body.slotTimes.length || body.slotTimes.length > 12 || body.slotTimes.some((t) => !TIME.test(t))) return res.status(400).json({ error: "Enter slot times like 10:00 or 14:30." });
      set.slotTimes = [...new Set(body.slotTimes)].sort();
    }
    if (body.callMinutes !== undefined) {
      if (!Number.isSafeInteger(body.callMinutes) || body.callMinutes < 10 || body.callMinutes > 180) return res.status(400).json({ error: "Call length must be 10 to 180 minutes." });
      set.callMinutes = body.callMinutes;
    }
    if (body.bookingOpen !== undefined) set.bookingOpen = body.bookingOpen === true;
    await getGuidanceSettings();
    const item = await GuidanceSettings.findOneAndUpdate({ key: "default" }, { $set: set }, { new: true }).lean();
    return res.json({ item });
  } catch (error) { return next(error); }
}

export async function adminListGuidanceBookings(req, res, next) {
  try {
    await releaseExpiredHolds();
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = {};
    const statuses = ["pending_payment", "confirmed", "payment_failed", "completed", "cancelled", "refunded"];
    if (req.query.status) { if (!statuses.includes(req.query.status)) return res.status(400).json({ error: "Invalid status." }); filter.status = req.query.status; }
    else filter.status = { $ne: "pending_payment" };
    if (req.query.when === "upcoming") filter.slotStart = { $gte: new Date(Date.now() - 60 * 60 * 1000) };
    if (req.query.when === "past") filter.slotStart = { $lt: new Date() };
    if (req.query.search) {
      if (typeof req.query.search !== "string" || req.query.search.length > 120) return res.status(400).json({ error: "Invalid search." });
      const m = new RegExp(req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ reference: m }, { "student.name": m }, { "student.email": m }, { "student.phone": m }];
    }
    const sort = req.query.when === "upcoming" ? { slotStart: 1 } : { createdAt: -1 };
    const [items, total, counts] = await Promise.all([
      GuidanceBooking.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      GuidanceBooking.countDocuments(filter),
      GuidanceBooking.aggregate([{ $group: { _id: "$status", count: { $sum: 1 }, amountMinor: { $sum: "$amountMinor" } } }]),
    ]);
    return res.json({ items, counts: Object.fromEntries(counts.map((c) => [c._id, { count: c.count, amountMinor: c.amountMinor }])), pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { return next(error); }
}

async function findBooking(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) { res.status(400).json({ error: "Invalid booking ID." }); return null; }
  const booking = await GuidanceBooking.findById(req.params.id).lean();
  if (!booking) { res.status(404).json({ error: "Booking not found." }); return null; }
  return booking;
}

export async function adminUpdateGuidanceStatus(req, res, next) {
  try {
    const booking = await findBooking(req, res); if (!booking) return undefined;
    const action = req.body?.action;
    if (!["complete", "cancel", "reopen"].includes(action)) return res.status(400).json({ error: "Choose Mark done, Cancel or Reopen." });
    if (!["confirmed", "completed", "cancelled"].includes(booking.status)) return res.status(409).json({ error: "Only paid bookings can be changed here." });
    const update = action === "complete"
      ? { $set: { status: "completed", completedAt: new Date(), adminNote: text(req.body?.note, 500) } }
      : action === "cancel"
        ? { $set: { status: "cancelled", adminNote: text(req.body?.note, 500) }, $unset: { slotLock: 1 } }
        : { $set: { status: "confirmed", completedAt: null, slotLock: lockKey(booking.slotStart) } };
    const item = await GuidanceBooking.findByIdAndUpdate(booking._id, update, { new: true }).lean()
      .catch((error) => { if (error.code === 11000) return "slot_taken"; throw error; });
    if (item === "slot_taken") return res.status(409).json({ error: "That slot now belongs to another booking." });
    return res.json({ item });
  } catch (error) { return next(error); }
}

export async function adminRefundGuidance(req, res, next) {
  try {
    const booking = await findBooking(req, res); if (!booking) return undefined;
    if (!["confirmed", "completed", "cancelled"].includes(booking.status) || !booking.paymentId) return res.status(409).json({ error: "Only a paid booking can be refunded." });
    if (booking.refund?.status === "processed" || booking.refund?.status === "pending") return res.status(409).json({ error: "This booking has already been refunded." });
    const reason = text(req.body?.reason, 500);
    if (reason.length < 3) return res.status(400).json({ error: "Write a short reason for the refund." });
    const amountMinor = req.body?.amountMinor === undefined ? booking.amountMinor : req.body.amountMinor;
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 100 || amountMinor > booking.amountMinor) return res.status(400).json({ error: "The refund amount must be between ₹1 and the amount paid." });
    const pay = gateway();
    if (!pay) return res.status(503).json({ error: "Razorpay is not configured on the server." });
    let refund;
    try {
      refund = await pay.client.payments.refund(booking.paymentId, { amount: amountMinor, notes: { reference: booking.reference, reason: reason.slice(0, 200) } });
    } catch (error) {
      return res.status(502).json({ error: `Razorpay could not process the refund${error?.error?.description ? `: ${error.error.description}` : "."}` });
    }
    const item = await GuidanceBooking.findByIdAndUpdate(booking._id, {
      $set: { status: "refunded", refund: { amountMinor, providerRefundId: refund.id || null, status: refund.status === "processed" ? "processed" : "pending", reason, at: new Date(), by: req.admin.id } },
      $unset: { slotLock: 1 },
    }, { new: true }).lean();
    return res.json({ item });
  } catch (error) { return next(error); }
}

export async function adminRetryGuidanceEmails(req, res, next) {
  try {
    const booking = await findBooking(req, res); if (!booking) return undefined;
    const item = await sendBookingEmails(booking._id);
    if (!item) return res.status(409).json({ error: "Emails are only sent for paid bookings." });
    const ok = item.customerEmailStatus === "sent" && item.adminEmailStatus === "sent";
    return res.status(ok ? 200 : 502).json({ item, ...(ok ? { message: "Emails sent." } : { error: "The email could not be sent. Check the Gmail settings and try again." }) });
  } catch (error) { return next(error); }
}

export async function adminGuidanceReceipt(req, res, next) {
  try {
    const booking = await findBooking(req, res); if (!booking) return undefined;
    if (!booking.paymentId) return res.status(409).json({ error: "No payment for this booking." });
    const pdf = await generateGuidanceReceipt(booking);
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="ProJenius-Guidance-Receipt-${booking.reference}.pdf"` });
    return res.send(pdf);
  } catch (error) { return next(error); }
}
