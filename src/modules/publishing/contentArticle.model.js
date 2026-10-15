import mongoose from "mongoose";

const imageSchema = new mongoose.Schema({
  mediaId: { type: mongoose.Schema.Types.ObjectId, default: null },
  filename: { type: String, required: true, match: /^[a-f\d-]{36}\.(png|jpe?g|webp)$/i },
  originalFilename: { type: String, trim: true, maxlength: 255, default: "" },
  mimeType: { type: String, enum: ["image/png", "image/jpeg", "image/webp"], required: true },
  size: { type: Number, required: true, max: 5 * 1024 * 1024 },
  uploadedAt: { type: Date, default: null },
  alt: { type: String, trim: true, maxlength: 180, default: "" },
}, { _id: false, strict: "throw" });

const videoSchema = new mongoose.Schema({
  provider: { type: String, enum: ["youtube", "vimeo"], required: true },
  videoId: { type: String, required: true, maxlength: 20, match: /^[A-Za-z0-9_-]+$/ },
  url: { type: String, required: true, maxlength: 500 },
  title: { type: String, trim: true, maxlength: 180, default: "" },
}, { _id: false, strict: "throw" });

const contentArticleSchema = new mongoose.Schema({
  contentType: { type: String, enum: ["news", "blog"], required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 180 },
  slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 190, match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ },
  summary: { type: String, required: true, trim: true, maxlength: 500 },
  body: { type: String, required: true, maxlength: 50000 },
  images: { type: [imageSchema], default: [] },
  videos: { type: [videoSchema], default: [] },
  thumbnailFilename: { type: String, default: null, match: [/^[a-f\d-]{36}\.(png|jpe?g|webp)$/i, "Invalid thumbnail filename"] },
  category: { type: String, trim: true, maxlength: 100, default: "" },
  tags: { type: [String], default: [], validate: (items) => items.length <= 20 },
  author: { name: { type: String, trim: true, maxlength: 120, default: "" }, role: { type: String, trim: true, maxlength: 120, default: "" } },
  seo: { title: { type: String, trim: true, maxlength: 180, default: "" }, description: { type: String, trim: true, maxlength: 320, default: "" } },
  status: { type: String, enum: ["draft", "scheduled", "published", "unpublished", "archived"], default: "draft", index: true },
  scheduledAt: { type: Date, default: null },
  timezone: { type: String, trim: true, maxlength: 80, default: "Asia/Kolkata" },
  publishedAt: { type: Date, default: null },
  announcementStatus: { type: String, enum: ["not_eligible", "pending", "queued"], default: "not_eligible", index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
}, { timestamps: true, strict: "throw" });

contentArticleSchema.index({ contentType: 1, slug: 1 }, { unique: true, name: "content_type_slug_unique" });
contentArticleSchema.index({ contentType: 1, status: 1, publishedAt: -1, _id: -1 }, { name: "public_content_listing" });
contentArticleSchema.index({ status: 1, publishedAt: -1, _id: -1 }, { name: "unified_public_content_listing" });
contentArticleSchema.index({ status: 1, scheduledAt: 1 }, { name: "content_schedule_scan" });
contentArticleSchema.index({ contentType: 1, category: 1, status: 1, publishedAt: -1 }, { name: "content_category_public" });
contentArticleSchema.index({ status: 1, category: 1, publishedAt: -1, _id: -1 }, { name: "unified_public_category_listing" });

export default mongoose.models.ContentArticle || mongoose.model("ContentArticle", contentArticleSchema, "content_articles");
