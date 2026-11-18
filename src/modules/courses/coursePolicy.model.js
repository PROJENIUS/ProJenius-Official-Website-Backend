import mongoose from "mongoose";

const policySectionSchema = new mongoose.Schema({
  key: { type: String, required: true, enum: ["general", "registration", "subscription", "refunds", "privacy", "cookies", "delivery", "support"] },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  content: { type: String, trim: true, maxlength: 5000, default: "" },
  order: { type: Number, required: true, min: 0 },
}, { _id: false });

const coursePolicySchema = new mongoose.Schema({
  version: { type: String, required: true, trim: true, maxlength: 80 },
  sections: { type: [policySectionSchema], required: true, validate: (value) => value.length === 8 },
  status: { type: String, enum: ["draft", "published"], default: "draft", index: true },
  publishedAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
}, { timestamps: true, strict: "throw" });
coursePolicySchema.index({ status: 1, publishedAt: -1 });

export default mongoose.models.CoursePolicy || mongoose.model("CoursePolicy", coursePolicySchema, "course_policies");
