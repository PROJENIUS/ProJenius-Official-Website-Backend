import mongoose from "mongoose";

const enrollmentSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true },
  requestKey: { type: String, required: true, unique: true, select: false },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true, index: true },
  batchId: { type: mongoose.Schema.Types.ObjectId, default: null },
  batchSnapshot: { code: { type: String, default: null }, label: { type: String, default: null }, deliveryMode: { type: String, default: null }, startsAt: { type: Date, default: null }, timezone: { type: String, default: null } },
  courseSnapshot: { title: { type: String, required: true }, slug: { type: String, required: true }, amountMinor: { type: Number, required: true }, currency: { type: String, required: true } },
  student: { name: { type: String, required: true }, email: { type: String, required: true, lowercase: true, index: true }, phone: { type: String, required: true } },
  terms: { version: { type: String, required: true }, acceptedAt: { type: Date, required: true }, policy: { type: String, required: true } },
  status: { type: String, enum: ["pending_payment", "enrolled", "payment_failed", "cancelled", "refunded"], default: "pending_payment", index: true },
  approvalStatus: { type: String, enum: ["awaiting_approval", "approved", "rejected"], default: "awaiting_approval", index: true },
  approvalReason: { type: String, maxlength: 500, default: "" },
  approvalAt: { type: Date, default: null },
  approvalBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  approvalEmailStatus: { type: String, enum: ["pending", "sent", "failed", "not_configured"], default: "pending" },
  approvalHistory: [{ action: { type: String, enum: ["approved", "rejected"], required: true }, reason: { type: String, maxlength: 500, default: "" }, actorAdminId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true }, at: { type: Date, required: true } }],
  paidAt: { type: Date, default: null },
  receiptStatus: { type: String, enum: ["pending", "ready", "failed"], default: "pending" },
  receiptTokenHash: { type: String, default: undefined, select: false },
  receiptTokenExpiresAt: { type: Date, default: undefined, select: false },
  customerEmailStatus: { type: String, enum: ["pending", "sent", "failed", "not_configured"], default: "pending" },
  adminEmailStatus: { type: String, enum: ["pending", "sent", "failed", "not_configured"], default: "pending" },
  notificationLockUntil: { type: Date, default: null, select: false },
}, { timestamps: true, strict: "throw" });

enrollmentSchema.index({ courseId: 1, createdAt: -1 });
enrollmentSchema.index({ "student.email": 1, courseId: 1, createdAt: -1 });
enrollmentSchema.index({ receiptTokenHash: 1 }, { unique: true, sparse: true, name: "course_receipt_token_hash_unique" });
export default mongoose.models.CourseEnrollment || mongoose.model("CourseEnrollment", enrollmentSchema, "course_enrollments");
