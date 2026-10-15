import mongoose from "mongoose";

const refundSchema = new mongoose.Schema({
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "CoursePayment", required: true, index: true },
  enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: "CourseEnrollment", required: true, index: true },
  providerRefundId: { type: String, unique: true, sparse: true },
  amountMinor: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  currency: { type: String, enum: ["INR"], default: "INR" },
  status: { type: String, enum: ["processed", "failed", "pending", "requested"], required: true },
  reason: { type: String, maxlength: 500, default: "" },
  actorAdminId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  processedAt: { type: Date, default: null },
}, { timestamps: true, strict: "throw" });

refundSchema.index({ status: 1, createdAt: -1 });
export default mongoose.models.CourseRefund || mongoose.model("CourseRefund", refundSchema, "course_refunds");
