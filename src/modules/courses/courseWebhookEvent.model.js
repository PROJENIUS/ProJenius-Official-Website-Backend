import mongoose from "mongoose";

const webhookEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true },
  event: { type: String, required: true, maxlength: 120 },
  payloadHash: { type: String, required: true, select: false },
  status: { type: String, enum: ["received", "processed", "ignored", "failed"], default: "received", index: true },
  processedAt: { type: Date, default: null },
}, { timestamps: true, strict: "throw" });

webhookEventSchema.index({ status: 1, createdAt: 1 });
export default mongoose.models.CourseWebhookEvent || mongoose.model("CourseWebhookEvent", webhookEventSchema, "course_webhook_events");
