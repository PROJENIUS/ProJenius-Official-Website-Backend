
import path from "node:path";
import { validateEnquiryPayload } from "./enquiry.validation.js";

import {
  createEnquiry,
  createJobApplication,
  deleteStoredUpload,
} from "./enquiry.service.js";

export async function submitEnquiry(req, res, next) {
  let submissionSaved = false;

  try {
    if (typeof req.body?.payload !== "string") {
      const error = new Error("Please complete the form and try again.");
      error.status = 400;
      throw error;
    }

    let parsedPayload;

    try {
      parsedPayload = JSON.parse(req.body.payload);
    } catch {
      const error = new Error("Please check your form details and try again.");
      error.status = 400;
      throw error;
    }

    const payload = validateEnquiryPayload(parsedPayload);

    if (payload.enquiryType === "career" && !req.file) {
      const error = new Error("Please upload your resume before submitting your application.");
      error.status = 400;
      throw error;
    }

    if (
      ["career", "internship"].includes(payload.enquiryType) &&
      req.file &&
      ![".pdf", ".doc", ".docx"].includes(
        path.extname(req.file.originalname).toLowerCase()
      )
    ) {
      const error = new Error("Resume files must be PDF, DOC or DOCX.");
      error.status = 400;
      throw error;
    }

    const result =
      payload.enquiryType === "career"
        ? await createJobApplication(payload, req.file)
        : await createEnquiry(payload, req.file);

    submissionSaved = true;

    return res.status(201).json({
      success: true,
      message: "Your submission has been received successfully.",
      data: result,
    });
  } catch (error) {
    // Preserve an uploaded file if the submission has already been saved.
    if (!submissionSaved) {
      await deleteStoredUpload(req.file);
    }

    return next(error);
  }
}
