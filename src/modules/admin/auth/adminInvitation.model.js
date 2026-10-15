import mongoose from "mongoose";
import { DEFAULT_ADMIN_PERMISSIONS, PERMISSIONS } from "../management/permissions.js";

const adminInvitationSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
  name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
  permissions: { type: [{ type: String, enum: PERMISSIONS }], default: () => [...DEFAULT_ADMIN_PERMISSIONS] },
  tokenHash: { type: String, required: true, unique: true, select: false },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  usedAt: { type: Date, default: null },
}, { timestamps: true });

export default mongoose.models.AdminInvitation || mongoose.model("AdminInvitation", adminInvitationSchema);
