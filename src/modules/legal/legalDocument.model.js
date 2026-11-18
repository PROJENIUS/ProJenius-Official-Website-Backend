import mongoose from "mongoose";

const legalSectionSchema = new mongoose.Schema(
  {
    heading: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },
    order: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false },
);

const legalDocumentSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      enum: ["terms", "privacy-policy", "course-terms"],
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    introduction: {
      type: String,
      required: true,
      trim: true,
      maxlength: 4000,
    },
    sections: {
      type: [legalSectionSchema],
      required: true,
    },
    revision: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
    version: {
      type: String,
      trim: true,
      maxlength: 80,
      default: "",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
  },
  {
    timestamps: true,
    strict: "throw",
    collection: "legal_documents",
  },
);

legalDocumentSchema.index({ key: 1 }, { unique: true });

export default mongoose.models.LegalDocument
  || mongoose.model("LegalDocument", legalDocumentSchema);
