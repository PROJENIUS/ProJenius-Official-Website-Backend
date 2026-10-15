import mongoose from "mongoose";

const publicationEventSchema = new mongoose.Schema({
  idempotencyKey: { type: String, required: true, unique: true, maxlength: 240 },
  contentType: { type: String, enum: ["news", "blog", "course"], required: true, index: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  eventType: { type: String, enum: ["first_published", "manual_announcement"], required: true },
  status: { type: String, enum: ["queued", "processing", "completed", "failed", "cancelled"], default: "queued", index: true },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "NewsletterCampaign", default: null },
  initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  lastError: { type: String, maxlength: 240, default: "" },
}, { timestamps: true, strict: "throw" });

publicationEventSchema.index({ status: 1, createdAt: 1 }, { name: "publication_event_work" });
export default mongoose.models.PublicationEvent || mongoose.model("PublicationEvent", publicationEventSchema, "publication_events");
