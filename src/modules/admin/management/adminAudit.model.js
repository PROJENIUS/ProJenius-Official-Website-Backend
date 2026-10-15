import mongoose from "mongoose";

const adminAuditSchema = new mongoose.Schema({
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true, index: true },
  targetAdminId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null, index: true },
  action: { type: String, required: true, maxlength: 80, index: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, strict: true });

adminAuditSchema.index({ createdAt: -1 });

export default mongoose.models.AdminAuditEvent || mongoose.model("AdminAuditEvent", adminAuditSchema, "admin_audit_events");
