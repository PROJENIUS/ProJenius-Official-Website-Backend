import mongoose from "mongoose";

const campaignSchema = new mongoose.Schema({
  idempotencyKey: { type: String, required: true, unique: true, maxlength: 240 },
  type: { type: String, enum: ["news", "blog", "course"], required: true, index: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: "PublicationEvent", default: null },
  titleSnapshot: { type: String, required: true, maxlength: 180 },
  summarySnapshot: { type: String, required: true, maxlength: 500 },
  categorySnapshot: { type: String, default: "", maxlength: 100 },
  urlSnapshot: { type: String, required: true, maxlength: 1000 },
  imageSnapshot: { type: String, default: "", maxlength: 1000 },
  imageMediaId: { type: mongoose.Schema.Types.ObjectId, default: null },
  status: { type: String, enum: ["queued", "processing", "sent", "failed", "cancelled"], default: "queued", index: true },
  eligibleCount: { type: Number, default: 0, min: 0 },
  recipientCursor: { type: mongoose.Schema.Types.ObjectId, default: null },
  recipientsMaterialized: { type: Boolean, default: false },
  sentCount: { type: Number, default: 0, min: 0 },
  failedCount: { type: Number, default: 0, min: 0 },
  suppressedCount: { type: Number, default: 0, min: 0 },
  leaseUntil: { type: Date, default: null, index: true },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  attempts: { type: Number, default: 0, min: 0 },
  maxAttempts: { type: Number, default: 5, min: 1, max: 20 },
  initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  lastError: { type: String, maxlength: 240, default: "" },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
}, { timestamps: true, strict: "throw" });

campaignSchema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1, createdAt: 1 }, { name: "newsletter_campaign_work" });
campaignSchema.index({ type: 1, createdAt: -1 }, { name: "newsletter_campaign_history" });

export default mongoose.models.NewsletterCampaign || mongoose.model("NewsletterCampaign", campaignSchema, "newsletter_campaigns");
