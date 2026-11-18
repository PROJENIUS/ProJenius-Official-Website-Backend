import mongoose from "mongoose";

const courseCommonFaqSchema = new mongoose.Schema({
  question: { type: String, required: true, trim: true, maxlength: 300 },
  answer: { type: String, required: true, trim: true, maxlength: 1500 },
  order: { type: Number, default: 0 },
  published: { type: Boolean, default: false, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
}, { timestamps: true, strict: "throw" });
courseCommonFaqSchema.index({ published: 1, order: 1 });

export default mongoose.models.CourseCommonFaq || mongoose.model("CourseCommonFaq", courseCommonFaqSchema, "course_common_faqs");
