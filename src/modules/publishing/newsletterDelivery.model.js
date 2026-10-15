import mongoose from "mongoose";

const deliverySchema = new mongoose.Schema({
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "NewsletterCampaign", required: true, index: true },
  subscriberId: { type: mongoose.Schema.Types.ObjectId, ref: "NewsletterSubscriber", required: true, index: true },
  status: { type: String, enum: ["queued", "processing", "sent", "failed", "suppressed"], default: "queued", index: true },
  attempts: { type: Number, default: 0, min: 0 },
  maxAttempts: { type: Number, default: 5, min: 1, max: 20 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  leaseUntil: { type: Date, default: null, index: true },
  lastAttemptAt: { type: Date, default: null },
  acceptedAt: { type: Date, default: null },
  providerMessageId: { type: String, maxlength: 200, default: "" },
  failureCode: { type: String, maxlength: 60, default: "" },
  lastError: { type: String, maxlength: 240, default: "" },
}, { timestamps: true, strict: "throw" });

deliverySchema.index({ campaignId: 1, subscriberId: 1 }, { unique: true, name: "campaign_subscriber_unique" });
deliverySchema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1, createdAt: 1 }, { name: "newsletter_delivery_work" });
deliverySchema.index({ campaignId: 1, status: 1 }, { name: "newsletter_delivery_campaign_status" });

export default mongoose.models.NewsletterDelivery || mongoose.model("NewsletterDelivery", deliverySchema, "newsletter_deliveries");
