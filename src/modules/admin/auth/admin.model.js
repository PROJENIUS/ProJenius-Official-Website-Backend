
/* =========================================================
   PROJENIUS BACKEND — ADMIN MODEL
   Responsibility: Store administrator account details
========================================================= */

import mongoose from "mongoose";
import { PERMISSIONS } from "../management/permissions.js";

// SECTION: ADMINISTRATOR SCHEMA
const adminSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "",
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },

    passwordHash: {
      type: String,
      required: true,
      select: false,
    },

    role: {
      type: String,
      enum: ["superadmin", "admin"],
      default: "admin",
      required: true,
    },

    isActive: {
      type: Boolean,
      default: true,
      required: true,
    },

    lastLoginAt: {
      type: Date,
      default: null,
    },

    sessionVersion: {
      type: Number,
      default: 0,
      min: 0,
    },
    permissions: {
      type: [{ type: String, enum: PERMISSIONS }],
      default: undefined,
    },
    removedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    strict: "throw",
  }
);

// Enforce the one-time active-superadmin bootstrap even if two setup processes race.
adminSchema.index(
  { role: 1 },
  {
    unique: true,
    partialFilterExpression: { role: "superadmin", isActive: true },
    name: "unique_active_superadmin",
  }
);

// SECTION: DATABASE MODEL
const Admin = mongoose.model("Admin", adminSchema);

export default Admin;
