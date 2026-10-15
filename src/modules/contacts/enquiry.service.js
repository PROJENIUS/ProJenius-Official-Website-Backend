
import fs from "node:fs/promises";

import Enquiry from "./enquiry.model.js";
import { createCareerApplication, JobApplication } from "../careers/index.js";
import { generateSubmissionPdf } from "../../shared/pdf/index.js";
import { sendSubmissionEmails } from "../../shared/email/index.js";
import { saveWithUniqueReference } from "../../shared/utilities/index.js";

function getCustomerEmail(answers) {
  for (const key of ["email", "emailAddress", "contactEmail"]) {
    if (typeof answers[key] === "string" && answers[key].trim()) {
      return answers[key].trim();
    }
  }

  return null;
}

function getCustomerName(answers) {
  for (const key of ["name", "fullName", "applicantName"]) {
    if (typeof answers[key] === "string" && answers[key].trim()) {
      return answers[key].trim();
    }
  }

  return "there";
}

function getSafeAttachment(file) {
  if (!file) return undefined;

  return {
    originalName: file.originalname.slice(0, 255),
    storedName: file.filename,
    mimeType: file.mimetype,
    size: file.size,
  };
}

async function notifySubmission(
  { Model, record, isJobApplication },
  runtime
) {
  try {
    const customerEmail = getCustomerEmail(record.answers);

    if (!customerEmail) {
      await Model.updateOne(
        { _id: record._id },
        {
          $set: {
            emailStatus: "failed",
            customerEmailStatus: "failed",
            adminEmailStatus: "failed",
            emailError: "Customer email address is missing.",
          },
        }
      );
      return;
    }

    const pdfBuffer = await runtime.generatePdf({
      referenceNumber: record.referenceNumber,
      enquiryType: record.enquiryType || "career",
      sourcePage: record.sourcePage,
      answers: record.answers,
      createdAt: record.createdAt,
      isJobApplication,
      attachmentName: isJobApplication
        ? record.resume?.originalName
        : record.attachment?.originalName,
    });

    const outcomes = await runtime.sendEmails({
      customerEmail,
      customerName: getCustomerName(record.answers),
      referenceNumber: record.referenceNumber,
      enquiryType: record.enquiryType || "career",
      answers: record.answers,
      createdAt: record.createdAt,
      pdfBuffer,
      isJobApplication,
    });

    const customerStatus = outcomes?.customer?.status === "sent" ? "sent" : "failed";
    const adminStatus = outcomes?.admin?.status === "sent" ? "sent" : "failed";
    const failures = [
      customerStatus === "failed" && `Customer email: ${outcomes?.customer?.error || "delivery failed."}`,
      adminStatus === "failed" && `Administrator email: ${outcomes?.admin?.error || "delivery failed."}`,
    ].filter(Boolean);

    await Model.updateOne(
      { _id: record._id },
      {
        $set: {
          emailStatus:
            customerStatus === "sent" && adminStatus === "sent" ? "sent" : "failed",
          customerEmailStatus: customerStatus,
          adminEmailStatus: adminStatus,
          emailError: failures.length ? failures.join(" ").slice(0, 500) : null,
          ...(customerStatus === "sent" ? { customerEmailSentAt: new Date() } : {}),
          ...(adminStatus === "sent" ? { adminEmailSentAt: new Date() } : {}),
        },
      }
    );
  } catch {
    console.error("Background submission notification processing failed.");

    try {
      await Model.updateOne(
        { _id: record._id },
        {
          $set: {
            emailStatus: "failed",
            customerEmailStatus: "failed",
            adminEmailStatus: "failed",
            emailError: "Notification processing failed.",
          },
        }
      );
    } catch {
      console.error("Could not persist notification status.");
    }
  }
}

const productionNotificationRuntime = {
  schedule(callback) {
    setImmediate(() => {
      void callback();
    });
  },
  generatePdf: generateSubmissionPdf,
  sendEmails: sendSubmissionEmails,
};

let notificationRuntime = productionNotificationRuntime;

// Test seam: all notification effects must be explicitly replaced in test mode.
export function setNotificationRuntimeForTests(runtime) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Notification test runtime is available only in test mode.");
  }

  if (
    !runtime ||
    typeof runtime.schedule !== "function" ||
    typeof runtime.generatePdf !== "function" ||
    typeof runtime.sendEmails !== "function"
  ) {
    throw new TypeError("A complete notification test runtime is required.");
  }

  const previousRuntime = notificationRuntime;
  notificationRuntime = runtime;

  return () => {
    notificationRuntime = previousRuntime;
  };
}

function startBackgroundNotifications(options) {
  const runtime = notificationRuntime;
  runtime.schedule(() => notifySubmission(options, runtime));
}

export async function createEnquiry(payload, file) {
  const enquiry = await saveWithUniqueReference(Enquiry, "PJ-ENQ", {
    enquiryType: payload.enquiryType,
    sourcePage: payload.sourcePage,
    answers: payload.answers,
    attachment: getSafeAttachment(file),
    emailStatus: "pending",
    customerEmailStatus: "pending",
    adminEmailStatus: "pending",
  });

  // PDF creation and email sending must not delay the HTTP response.
  startBackgroundNotifications({
    Model: Enquiry,
    record: enquiry,
    isJobApplication: false,
  });

  return {
    id: enquiry._id.toString(),
    referenceNumber: enquiry.referenceNumber,
    enquiryType: enquiry.enquiryType,
    status: enquiry.status,
    emailStatus: "pending",
    customerEmailStatus: "pending",
    adminEmailStatus: "pending",
    createdAt: enquiry.createdAt,
  };
}

export async function createJobApplication(payload, resume) {
  const application = await createCareerApplication(payload, resume);

  startBackgroundNotifications({
    Model: JobApplication,
    record: application,
    isJobApplication: true,
  });

  return {
    id: application._id.toString(),
    referenceNumber: application.referenceNumber,
    status: application.status,
    emailStatus: "pending",
    customerEmailStatus: "pending",
    adminEmailStatus: "pending",
    createdAt: application.createdAt,
  };
}

export async function deleteStoredUpload(file) {
  if (!file?.path) return;

  try {
    await fs.unlink(file.path);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error("Could not remove failed contact upload.");
    }
  }
}
