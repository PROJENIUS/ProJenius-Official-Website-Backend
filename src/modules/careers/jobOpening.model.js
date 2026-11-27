import mongoose from "mongoose";
import { JOB_OPENING_RULES as RULES } from "./jobOpening.rules.js";

const text = (name, required = true) => ({ type: String, trim: true, required, maxlength: RULES.text[name].max, ...(required ? {} : { default: "" }) });
const list = (name) => ({ type: [{ type: String, trim: true, maxlength: RULES.lists[name].itemMax }], default: [] });

/* A role published on Join Our Team. Applications for it are stored in
   careers_job_applications with answers.openingSlug = slug. */
const jobOpeningSchema = new mongoose.Schema({
  slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 90, match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ },
  title: text("title"),
  department: text("department"),
  employmentType: { type: String, enum: RULES.employmentTypes, required: true },
  workMode: { type: String, enum: RULES.workModes, required: true },
  location: text("location"),
  experience: text("experience"),
  salary: text("salary", false),
  positions: { type: Number, min: RULES.positions.min, max: RULES.positions.max, default: 1 },
  summary: text("summary"),
  responsibilities: list("responsibilities"),
  requirements: list("requirements"),
  niceToHave: list("niceToHave"),
  benefits: list("benefits"),
  skills: list("skills"),
  status: { type: String, enum: RULES.statuses, default: "draft", index: true },
  closesOn: { type: Date, default: null },
  postedAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
}, { timestamps: true, strict: "throw", collection: "careers_job_openings" });

jobOpeningSchema.index({ slug: 1 }, { unique: true });
jobOpeningSchema.index({ status: 1, postedAt: -1 }, { name: "public_openings" });

export default mongoose.models.JobOpening || mongoose.model("JobOpening", jobOpeningSchema);
