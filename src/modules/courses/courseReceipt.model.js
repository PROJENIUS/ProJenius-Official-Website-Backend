import mongoose from "mongoose";

const receiptSchema = new mongoose.Schema({
  enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: "CourseEnrollment", required: true, unique: true },
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "CoursePayment", required: true, unique: true },
  receiptNumber: { type: String, required: true, unique: true },
  filename: { type: String, required: true, unique: true },
  sha256: { type: String, required: true, maxlength: 64 },
  amountMinor: { type: Number, required: true, min: 1 },
  currency: { type: String, enum: ["INR"], required: true },
  generatedAt: { type: Date, required: true },
}, { timestamps: true, strict: "throw" });

export default mongoose.models.CourseReceipt || mongoose.model("CourseReceipt", receiptSchema, "course_receipts");
