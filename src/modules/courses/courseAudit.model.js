import mongoose from "mongoose";

const auditSchema = new mongoose.Schema({
  eventKey: { type: String, unique: true, sparse: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true, index: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null, index: true },
  action: { type: String, required: true, maxlength: 100 },
  changes: { type: mongoose.Schema.Types.Mixed, default: {} },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: { createdAt: true, updatedAt: false }, strict: "throw" });

auditSchema.index({ courseId: 1, createdAt: -1 });
export default mongoose.models.CourseAudit || mongoose.model("CourseAudit", auditSchema, "course_audit_logs");
