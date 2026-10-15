import mongoose from "mongoose";

const jobSchema = new mongoose.Schema({
  dedupeKey: { type: String, required: true, unique: true, maxlength: 240 },
  enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: "CourseEnrollment", required: true, index: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true, index: true },
  type: { type: String, enum: ["payment_customer", "payment_admin", "receipt_link", "approved", "rejected", "schedule_changed", "cancelled"], required: true },
  recipient: { type: String, required: true, maxlength: 254 },
  status: { type: String, enum: ["queued", "processing", "sent", "failed", "not_configured"], default: "queued", index: true },
  attempts: { type: Number, default: 0, min: 0 },
  maxAttempts: { type: Number, required: true, min: 1, max: 20 },
  nextRetryAt: { type: Date, default: Date.now, index: true },
  lastAttemptAt: { type: Date, default: null },
  leaseUntil: { type: Date, default: null, index: true },
  lastError: { type: String, maxlength: 300, default: "" },
  finalFailure: { type: Boolean, default: false },
  context: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, strict: "throw" });

jobSchema.index({ status: 1, nextRetryAt: 1, leaseUntil: 1, createdAt: 1 }, { name: "course_notification_work" });
jobSchema.index({ enrollmentId: 1, type: 1, dedupeKey: 1 }, { name: "course_notification_history" });

export default mongoose.models.CourseNotificationJob || mongoose.model("CourseNotificationJob", jobSchema, "course_notification_jobs");
