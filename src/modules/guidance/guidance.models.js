/* =========================================================
   PROJENIUS BACKEND — CAREER GUIDANCE (1:1 call) MODELS
========================================================= */

import mongoose from "mongoose";

// One settings document: fee, Google Meet link and the daily fixed slots.
const settingsSchema = new mongoose.Schema({
  key: { type: String, default: "default", unique: true },
  feeMinor: { type: Number, default: 9900, min: 100, validate: Number.isSafeInteger },
  meetLink: { type: String, default: "", maxlength: 300 },
  slotTimes: { type: [String], default: ["10:00", "14:30", "16:00", "18:00"] },
  callMinutes: { type: Number, default: 30, min: 10, max: 180 },
  bookingOpen: { type: Boolean, default: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
}, { timestamps: true, strict: "throw" });

export const GuidanceSettings = mongoose.models.GuidanceSettings
  || mongoose.model("GuidanceSettings", settingsSchema, "guidance_settings");

const bookingSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true },
  requestKey: { type: String, required: true, unique: true, select: false },
  student: {
    name: { type: String, required: true, maxlength: 120 },
    email: { type: String, required: true, lowercase: true, maxlength: 254, index: true },
    phone: { type: String, required: true, maxlength: 30 },
  },
  targetRole: { type: String, default: "", maxlength: 160 },
  notes: { type: String, default: "", maxlength: 1000 },
  slotStart: { type: Date, required: true, index: true },
  slotLabel: { type: String, required: true, maxlength: 120 },
  slotType: { type: String, enum: ["fixed", "custom"], default: "fixed" },
  callMinutes: { type: Number, default: 30 },
  // Holds the slot while paying and after payment; removed when the booking is released.
  slotLock: { type: String, default: undefined },
  holdExpiresAt: { type: Date, default: null },
  amountMinor: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  currency: { type: String, enum: ["INR"], default: "INR" },
  status: { type: String, enum: ["pending_payment", "confirmed", "payment_failed", "completed", "cancelled", "refunded"], default: "pending_payment", index: true },
  orderId: { type: String, required: true, unique: true },
  paymentId: { type: String, default: null },
  paidAt: { type: Date, default: null },
  failureReason: { type: String, default: "", maxlength: 300 },
  meetLink: { type: String, default: "", maxlength: 300 },
  termsAcceptedAt: { type: Date, required: true },
  receiptTokenHash: { type: String, default: null, select: false },
  receiptTokenExpiresAt: { type: Date, default: null },
  customerEmailStatus: { type: String, enum: ["pending", "sent", "failed", "not_configured"], default: "pending" },
  adminEmailStatus: { type: String, enum: ["pending", "sent", "failed", "not_configured"], default: "pending" },
  emailError: { type: String, default: "", maxlength: 300 },
  refund: {
    amountMinor: { type: Number, default: null },
    providerRefundId: { type: String, default: null },
    status: { type: String, enum: ["", "processed", "pending", "failed"], default: "" },
    reason: { type: String, default: "", maxlength: 500 },
    at: { type: Date, default: null },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  },
  completedAt: { type: Date, default: null },
  adminNote: { type: String, default: "", maxlength: 500 },
}, { timestamps: true, strict: "throw" });

// Two people can never hold or own the same slot.
bookingSchema.index({ slotLock: 1 }, { unique: true, sparse: true, name: "unique_slot_lock" });
bookingSchema.index({ createdAt: -1 });

export const GuidanceBooking = mongoose.models.GuidanceBooking
  || mongoose.model("GuidanceBooking", bookingSchema, "guidance_bookings");

export async function getGuidanceSettings() {
  const existing = await GuidanceSettings.findOne({ key: "default" }).lean();
  if (existing) return existing;
  try {
    return (await GuidanceSettings.create({ key: "default" })).toObject();
  } catch (error) {
    if (error.code === 11000) return GuidanceSettings.findOne({ key: "default" }).lean();
    throw error;
  }
}
