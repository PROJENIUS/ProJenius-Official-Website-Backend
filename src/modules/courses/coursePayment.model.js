import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema({
  enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: "CourseEnrollment", required: true, index: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true, index: true },
  provider: { type: String, enum: ["razorpay"], default: "razorpay" },
  orderId: { type: String, required: true, unique: true },
  paymentId: { type: String, sparse: true, unique: true, default: undefined },
  amountMinor: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  currency: { type: String, enum: ["INR"], required: true },
  status: { type: String, enum: ["created", "pending", "authorized", "captured", "failed", "cancelled", "refunded", "partially_refunded"], default: "created", index: true },
  gatewayStatus: { type: String, default: null },
  capturedAt: { type: Date, default: null },
  refundedAmountMinor: { type: Number, default: 0, min: 0 },
  failureCode: { type: String, default: null, maxlength: 100 },
  failureDescription: { type: String, default: null, maxlength: 500 },
  gatewayFeeMinor: { type: Number, default: null, min: 0 },
  attempts: [{ paymentId: { type: String, maxlength: 200 }, status: { type: String, maxlength: 40 }, gatewayStatus: { type: String, maxlength: 80 }, failureCode: { type: String, maxlength: 100 }, failureDescription: { type: String, maxlength: 500 }, gatewayFeeMinor: { type: Number, min: 0 }, recordedAt: { type: Date, default: Date.now } }],
}, { timestamps: true, strict: "throw" });

paymentSchema.index({ courseId: 1, status: 1, createdAt: -1 });
paymentSchema.index({ status: 1, capturedAt: -1 });
export default mongoose.models.CoursePayment || mongoose.model("CoursePayment", paymentSchema, "course_payments");
