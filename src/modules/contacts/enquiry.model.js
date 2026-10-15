import mongoose from "mongoose";

const attachmentSchema = new mongoose.Schema(
  {
    originalName: { type: String, maxlength: 255 },
    storedName: { type: String, maxlength: 255 },
    mimeType: { type: String, maxlength: 100 },
    size: { type: Number, min: 1, max: 5 * 1024 * 1024 },
  },
  { _id: false }
);

const enquirySchema = new mongoose.Schema(
  {
    referenceNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    enquiryType: {
      type: String,
      required: true,
      enum: [
        "startup",
        "development",
        "workshop",
        "course",
        "internship",
        "general",
      ],
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

    status: {
      type: String,
      enum: ["new", "in_progress", "resolved", "closed"],
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

    attachment: {
      type: attachmentSchema,
      default: undefined,
    },
  },
  {
    timestamps: true,
    strict: true,
  }
);

enquirySchema.index({ createdAt: -1 });
enquirySchema.index({ enquiryType: 1, status: 1, createdAt: -1 });

const Enquiry =
  mongoose.models.Enquiry ||
  mongoose.model("Enquiry", enquirySchema, "enquiries");

export default Enquiry;
