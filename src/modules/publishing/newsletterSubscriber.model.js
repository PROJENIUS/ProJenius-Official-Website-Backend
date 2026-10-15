import mongoose from "mongoose";

const consentHistoryEntrySchema = new mongoose.Schema({
  eventId: { type: String, trim: true, maxlength: 80, default: "" },
  source: { type: String, trim: true, maxlength: 100, default: "website-footer" },
  acceptedAt: { type: Date, required: true },
  policyVersion: { type: String, trim: true, maxlength: 40, default: "newsletter-v1" },
}, { _id: false, strict: "throw" });

const subscriberSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
  status: { type: String, enum: ["pending", "active", "unsubscribed"], default: "pending", index: true },
  consent: { source: { type: String, trim: true, maxlength: 100, default: "website-footer" }, acceptedAt: { type: Date, default: null }, policyVersion: { type: String, trim: true, maxlength: 40, default: "newsletter-v1" } },
  consentHistory: { type: [consentHistoryEntrySchema], default: [] },
  subscriptionEventId: { type: String, trim: true, maxlength: 80, default: undefined },
  subscribedAt: { type: Date, default: Date.now },
  confirmedAt: { type: Date, default: null },
  unsubscribedAt: { type: Date, default: null },
  unsubscribeHistory: { type: [Date], default: [] },
  confirmationTokenHash: { type: String, select: false, default: undefined },
  confirmationTokenExpiresAt: { type: Date, select: false, default: undefined },
  confirmationLeaseUntil: { type: Date, select: false, default: null },
  lastConfirmationAttemptAt: { type: Date, select: false, default: null },
  confirmationAttemptCount: { type: Number, select: false, default: 0, min: 0 },
  welcomeEmailStatus: { type: String, enum: ["not_queued", "queued", "processing", "sent", "failed"], default: "not_queued", index: true },
  welcomeEmailAttempts: { type: Number, default: 0, min: 0 },
  welcomeEmailNextAttemptAt: { type: Date, default: null },
  welcomeEmailLeaseUntil: { type: Date, default: null },
  welcomeEmailQueuedAt: { type: Date, default: null },
  welcomeEmailSentAt: { type: Date, default: null },
  welcomeEmailLastError: { type: String, maxlength: 240, default: "" },
  welcomeEmailMessageId: { type: String, maxlength: 200, default: "" },
  unsubscribeTokenHash: { type: String, select: false, default: undefined },
  unsubscribeTokenVersion: { type: Number, default: 0, min: 0, select: false },
}, { timestamps: true, strict: "throw" });

subscriberSchema.index({ email: 1 }, { unique: true, name: "newsletter_email_unique" });
subscriberSchema.index({ status: 1, createdAt: -1 }, { name: "newsletter_subscriber_status" });
subscriberSchema.index({ confirmationTokenHash: 1 }, { unique: true, sparse: true, name: "newsletter_confirmation_token_unique" });
subscriberSchema.index({ unsubscribeTokenHash: 1 }, { unique: true, sparse: true, name: "newsletter_unsubscribe_token_unique" });
subscriberSchema.index({ status: 1, welcomeEmailStatus: 1, welcomeEmailNextAttemptAt: 1, welcomeEmailLeaseUntil: 1 }, { name: "newsletter_welcome_work" });

export default mongoose.models.NewsletterSubscriber || mongoose.model("NewsletterSubscriber", subscriberSchema, "newsletter_subscribers");
