import JobApplication from "./jobApplication.model.js";
import { saveWithUniqueReference } from "../../shared/utilities/index.js";

/** Persist a career submission using the existing job_applications model. */
export function createCareerApplication(payload, resume) {
  return saveWithUniqueReference(JobApplication, "PJ-JOB", {
    sourcePage: payload.sourcePage,
    answers: payload.answers,
    resume: resume
      ? {
          originalName: resume.originalname.slice(0, 255),
          storedName: resume.filename,
          mimeType: resume.mimetype,
          size: resume.size,
        }
      : undefined,
    emailStatus: "pending",
    customerEmailStatus: "pending",
    adminEmailStatus: "pending",
  });
}
