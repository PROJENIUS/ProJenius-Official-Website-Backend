/*
 * =========================================================
 * PROJENIUS — ADMIN CONTACT CONTROLLER
 * Responsibility: Enquiries and job applications
 * =========================================================
 */

import mongoose from "mongoose";
import fs from "node:fs";
import path from "node:path";

import Enquiry from "./enquiry.model.js";
import { JobApplication } from "../careers/index.js";
import { PRIVATE_UPLOAD_DIR } from "./enquiry.upload.js";
import { generateSubmissionPdf } from "../../shared/pdf/index.js";

const ENQUIRY_STATUSES = [
  "new",
  "in_progress",
  "resolved",
  "closed",
];

const APPLICATION_STATUSES = [
  "new",
  "reviewing",
  "shortlisted",
  "rejected",
  "hired",
];

// SECTION: SEARCH HELPERS

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getPagination(query) {
  const requestedPage = Number.parseInt(query.page, 10);
  const requestedLimit = Number.parseInt(query.limit, 10);

  const page = Math.max(
    1,
    Number.isFinite(requestedPage) ? requestedPage : 1
  );

  const limit = Math.min(
    100,
    Math.max(
      1,
      Number.isFinite(requestedLimit) ? requestedLimit : 20
    )
  );

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

function getSearchFilter(search) {
  if (typeof search !== "string" || !search.trim()) {
    return {};
  }

  const regex = new RegExp(escapeRegex(search.trim()), "i");

  return {
    $or: [
      { "answers.name": regex },
      { "answers.fullName": regex },
      { "answers.applicantName": regex },
      { "answers.email": regex },
      { "answers.emailAddress": regex },
      { "answers.phone": regex },
      { "answers.message": regex },
      { referenceNumber: regex },
    ],
  };
}

function applyDateFilter(query, filter) {
  const createdAt = {};
  for (const [key, operator, endOfDay] of [
    ["from", "$gte", false],
    ["to", "$lte", true],
  ]) {
    if (query[key] === undefined) continue;
    if (typeof query[key] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(query[key])) {
      return "Date filters must use YYYY-MM-DD.";
    }

    const date = new Date(`${query[key]}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== query[key]) {
      return "Invalid date filter.";
    }
    createdAt[operator] = date;
  }

  if (createdAt.$gte && createdAt.$lte && createdAt.$gte > createdAt.$lte) {
    return "The start date must not be after the end date.";
  }
  if (Object.keys(createdAt).length) filter.createdAt = createdAt;
  return null;
}

function invalidId(res) {
  return res.status(400).json({
    error: "Invalid record ID.",
  });
}

function notFound(res) {
  return res.status(404).json({
    error: "Record not found.",
  });
}

function invalidQuery(res, message) {
  return res.status(400).json({
    error: message,
  });
}

// SECTION: ENQUIRY LIST

export async function listEnquiries(req, res, next) {
  try {
    const { page, limit, skip } = getPagination(req.query);

    const filter = {
      ...getSearchFilter(req.query.search),
    };

    const dateError = applyDateFilter(req.query, filter);
    if (dateError) return invalidQuery(res, dateError);

    if (req.query.type !== undefined) {
      if (
        typeof req.query.type !== "string" ||
        ![
          "startup",
          "development",
          "workshop",
          "course",
          "internship",
          "general",
        ].includes(req.query.type)
      ) {
        return invalidQuery(res, "Invalid enquiry type.");
      }

      filter.enquiryType = req.query.type;
    }

    if (req.query.status !== undefined) {
      if (
        typeof req.query.status !== "string" ||
        !ENQUIRY_STATUSES.includes(req.query.status)
      ) {
        return invalidQuery(res, "Invalid enquiry status.");
      }

      filter.status = req.query.status;
    }

    if (req.query.read === "true") {
      filter.isRead = true;
    } else if (req.query.read === "false") {
      filter.isRead = false;
    } else if (req.query.read !== undefined) {
      return invalidQuery(res, "The read filter must be true or false.");
    }

    const [items, total] = await Promise.all([
      Enquiry.find(filter)
        .select("referenceNumber enquiryType sourcePage status isRead emailStatus customerEmailStatus adminEmailStatus createdAt answers.name answers.fullName answers.applicantName answers.email answers.emailAddress answers.contactEmail")
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),

      Enquiry.countDocuments(filter),
    ]);

    return res.status(200).json({
      items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return next(error);
  }
}

export async function getDashboardStats(_req, res, next) {
  try {
    const [enquiries, careerApplications] = await Promise.all([
      Enquiry.countDocuments(),
      JobApplication.countDocuments(),
    ]);
    return res.status(200).json({ enquiries, careerApplications });
  } catch (error) { return next(error); }
}

// SECTION: SINGLE ENQUIRY DETAILS

export async function getEnquiry(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return invalidId(res);
    }

    const enquiry = await Enquiry.findById(req.params.id)
      .select("-attachment.storedName")
      .lean()
      .exec();

    if (!enquiry) {
      return notFound(res);
    }

    await Enquiry.updateOne(
      { _id: enquiry._id },
      { $set: { isRead: true } }
    ).exec();

    return res.status(200).json({
      item: {
        ...enquiry,
        isRead: true,
      },
    });
  } catch (error) {
    return next(error);
  }
}

// SECTION: UPDATE ENQUIRY STATUS

export async function updateEnquiryStatus(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return invalidId(res);
    }

    const { status } = req.body || {};

    if (!ENQUIRY_STATUSES.includes(status)) {
      return invalidQuery(res, "Invalid enquiry status.");
    }

    const item = await Enquiry.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      {
        new: true,
        runValidators: true,
      }
    )
      .select("-answers -attachment.storedName")
      .lean()
      .exec();

    if (!item) {
      return notFound(res);
    }

    return res.status(200).json({ item });
  } catch (error) {
    return next(error);
  }
}

// SECTION: JOB APPLICATION LIST

export async function listJobApplications(req, res, next) {
  try {
    const { page, limit, skip } = getPagination(req.query);

    const filter = {
      ...getSearchFilter(req.query.search),
    };

    const dateError = applyDateFilter(req.query, filter);
    if (dateError) return invalidQuery(res, dateError);

    if (req.query.status !== undefined) {
      if (
        typeof req.query.status !== "string" ||
        !APPLICATION_STATUSES.includes(req.query.status)
      ) {
        return invalidQuery(res, "Invalid job application status.");
      }

      filter.status = req.query.status;
    }

    if (req.query.read === "true") {
      filter.isRead = true;
    } else if (req.query.read === "false") {
      filter.isRead = false;
    } else if (req.query.read !== undefined) {
      return invalidQuery(res, "The read filter must be true or false.");
    }

    const [items, total] = await Promise.all([
      JobApplication.find(filter)
        .select("referenceNumber sourcePage status isRead emailStatus customerEmailStatus adminEmailStatus createdAt answers.name answers.fullName answers.applicantName answers.email answers.emailAddress answers.contactEmail")
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),

      JobApplication.countDocuments(filter),
    ]);

    return res.status(200).json({
      items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return next(error);
  }
}

// SECTION: SINGLE JOB APPLICATION DETAILS

export async function getJobApplication(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return invalidId(res);
    }

    const application = await JobApplication.findById(req.params.id)
      .select("-resume.storedName")
      .lean()
      .exec();

    if (!application) {
      return notFound(res);
    }

    await JobApplication.updateOne(
      { _id: application._id },
      { $set: { isRead: true } }
    ).exec();

    return res.status(200).json({
      item: {
        ...application,
        isRead: true,
      },
    });
  } catch (error) {
    return next(error);
  }
}

// SECTION: UPDATE JOB APPLICATION STATUS

export async function updateJobApplicationStatus(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return invalidId(res);
    }

    const { status } = req.body || {};

    if (!APPLICATION_STATUSES.includes(status)) {
      return invalidQuery(res, "Invalid job application status.");
    }

    const item = await JobApplication.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      {
        new: true,
        runValidators: true,
      }
    )
      .select("-answers -resume.storedName")
      .lean()
      .exec();

    if (!item) {
      return notFound(res);
    }

    return res.status(200).json({ item });
  } catch (error) {
    return next(error);
  }
}

// SECTION: PRIVATE FILE DOWNLOAD HELPER

function getPrivateFilePath(storedName) {
  if (
    typeof storedName !== "string" ||
    !storedName ||
    path.basename(storedName) !== storedName
  ) {
    return null;
  }

  const resolvedDirectory = path.resolve(PRIVATE_UPLOAD_DIR);
  const resolvedFile = path.resolve(resolvedDirectory, storedName);

  if (!resolvedFile.startsWith(`${resolvedDirectory}${path.sep}`)) {
    return null;
  }

  return resolvedFile;
}

function sendPrivateDownload(res, filepath, originalName, next) {
  if (!filepath) {
    return res.status(400).json({
      error: "Invalid stored file reference.",
    });
  }

  fs.stat(filepath, (error, stats) => {
    if (error || !stats.isFile()) {
      return res.status(404).json({
        error: "Stored file not found.",
      });
    }

    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");

    return res.download(
      filepath,
      path.basename(originalName || "download"),
      (downloadError) => {
        if (downloadError && !res.headersSent) {
          return next(downloadError);
        }
      }
    );
  });
}

// SECTION: DOWNLOAD ENQUIRY ATTACHMENT

export async function downloadEnquiryAttachment(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return invalidId(res);
    }

    const enquiry = await Enquiry.findById(req.params.id)
      .select("attachment")
      .lean()
      .exec();

    if (!enquiry?.attachment?.storedName) {
      return res.status(404).json({
        error: "Enquiry attachment not found.",
      });
    }

    const filepath = getPrivateFilePath(enquiry.attachment.storedName);

    return sendPrivateDownload(
      res,
      filepath,
      enquiry.attachment.originalName,
      next
    );
  } catch (error) {
    return next(error);
  }
}

// SECTION: DOWNLOAD JOB APPLICATION RESUME

export async function downloadJobApplicationResume(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return invalidId(res);
    }

    const application = await JobApplication.findById(req.params.id)
      .select("resume.originalName resume.storedName")
      .lean()
      .exec();

    if (!application?.resume?.storedName) {
      return res.status(404).json({
        error: "Job application resume not found.",
      });
    }

    const filepath = getPrivateFilePath(application.resume.storedName);

    return sendPrivateDownload(
      res,
      filepath,
      application.resume.originalName,
      next
    );
  } catch (error) {
    return next(error);
  }
}

// SECTION: ON-DEMAND PDF RECEIPTS FROM SAVED RECORDS

async function sendSubmissionReceipt(res, record, isJobApplication) {
  const pdf = await generateSubmissionPdf({
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

  res.set({
    "Cache-Control": "no-store",
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="ProJenius-${record.referenceNumber}.pdf"`,
    "X-Content-Type-Options": "nosniff",
  });
  return res.status(200).send(pdf);
}

export async function downloadEnquiryReceipt(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return invalidId(res);
    const record = await Enquiry.findById(req.params.id).lean().exec();
    if (!record) return notFound(res);
    return await sendSubmissionReceipt(res, record, false);
  } catch (error) {
    return next(error);
  }
}

export async function downloadJobApplicationReceipt(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return invalidId(res);
    const record = await JobApplication.findById(req.params.id).lean().exec();
    if (!record) return notFound(res);
    return await sendSubmissionReceipt(res, record, true);
  } catch (error) {
    return next(error);
  }
}
