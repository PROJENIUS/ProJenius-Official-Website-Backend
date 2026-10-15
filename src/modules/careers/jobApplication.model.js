import mongoose from "mongoose";

const resumeSchema = new mongoose.Schema(
  {
    originalName: {
      type: String,
      required: true,
      maxlength: 255,
    },

    storedName: {
      type: String,
      required: true,
      maxlength: 100,
    },

    mimeType: {
      type: String,
      required: true,
      maxlength: 100,
    },

    size: {
      type: Number,
      required: true,
      min: 1,
      max: 5 * 1024 * 1024,
    },
  },
  { _id: false }
);

const jobApplicationSchema = new mongoose.Schema(
  {
    referenceNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    sourcePage: {
      type: String,
      trim: true,
      maxlength: 100,
      default: "contact",
    },

    answers: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },

    resume: {
      type: resumeSchema,
    },

    status: {
      type: String,
      enum: ["new", "reviewing", "shortlisted", "rejected", "hired"],
      default: "new",
      index: true,
    },

    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },

    emailStatus: {
      type: String,
      enum: ["pending", "sent", "failed"],
      default: "pending",
      index: true,
    },

    customerEmailStatus: {
      type: String,
      enum: ["pending", "sent", "failed"],
      default: "pending",
    },

    adminEmailStatus: {
      type: String,
      enum: ["pending", "sent", "failed"],
      default: "pending",
    },

    emailError: {
      type: String,
      maxlength: 500,
      default: null,
    },

    customerEmailSentAt: {
      type: Date,
      default: null,
    },

    adminEmailSentAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    strict: true,
  }
);

jobApplicationSchema.index({ createdAt: -1 });
jobApplicationSchema.index({ status: 1, createdAt: -1 });

const JobApplication =
  mongoose.models.JobApplication ||
  mongoose.model(
    "JobApplication",
    jobApplicationSchema,
    "job_applications"
  );

export default JobApplication;
