import mongoose from "mongoose";
import CoursePolicy from "../courses/coursePolicy.model.js";
import { getCurrentCoursePolicy } from "../courses/courseContent.controller.js";
import { LEGAL_DOCUMENT_DEFAULTS } from "./legalDocument.defaults.js";
import LegalDocument from "./legalDocument.model.js";

const LEGAL_KEYS = new Set(Object.keys(LEGAL_DOCUMENT_DEFAULTS));

function normalizeCoursePolicy(policy) {
  const policySections = (policy.sections || []).map((section) => ({
    heading: section.title || "Course terms",
    body: section.content || "",
    order: section.order || 0,
  }));
  const legacyPageSections = [
    {
      heading: "Before you register",
      body: "Check the programme, delivery mode, schedule and fee before paying. Your registration is confirmed once the payment succeeds, and the receipt is sent by email.",
    },
    {
      heading: "Refunds and changes",
      body: "Participant cancellations, non-attendance and personal-plan changes do not ordinarily qualify for a refund after payment. Batch changes depend on availability and written approval. Rejection does not automatically issue a refund. Verified duplicate charges, ProJenius cancellations, applicable law and payment-provider decisions are handled on their individual facts.",
    },
  ].map((section, index) => ({
    ...section,
    order: policySections.length + index,
  }));

  return {
    key: "course-terms",
    title: "Terms & Conditions and Refund Policy",
    introduction: "Review the programme details, delivery mode, schedule and fees carefully before registering. Payment alone does not mean a registration has been approved.",
    sections: [...policySections, ...legacyPageSections],
    version: policy.version || "",
    lastUpdated: policy.lastUpdated || policy.publishedAt || null,
    isProvisional: !policy.publishedAt,
  };
}

function publicShape(document) {
  const sections = (document.sections || []).map((section) => ({
    heading: section.heading || section.title,
    body: section.body || section.content || "",
    order: section.order || 0,
  }));

  return {
    key: document.key,
    title: document.title,
    introduction: document.introduction,
    sections,
    lastUpdated: document.updatedAt || document.lastUpdated || null,
    isProvisional: Boolean(document.isProvisional),
    ...(document.key === "course-terms" ? { version: document.version } : {}),
  };
}

function validKey(value) {
  return LEGAL_KEYS.has(value);
}

export async function getPublicLegalDocument(req, res, next) {
  try {
    if (!validKey(req.params.key)) {
      return res.status(404).json({ error: "Legal document not found." });
    }

    let document = await LegalDocument.findOne({ key: req.params.key }).lean();
    if (!document && req.params.key === "course-terms") {
      const policy = await getCurrentCoursePolicy();
      document = normalizeCoursePolicy(policy);
    }
    if (!document) {
      document = {
        ...LEGAL_DOCUMENT_DEFAULTS[req.params.key],
        lastUpdated: LEGAL_DOCUMENT_DEFAULTS[req.params.key].effectiveAt || null,
        isProvisional: false,
      };
    }

    res.set("Cache-Control", "no-store");
    return res.json({ item: publicShape(document) });
  } catch (error) {
    return next(error);
  }
}

export async function getAdminLegalDocument(req, res, next) {
  try {
    if (!validKey(req.params.key)) {
      return res.status(404).json({ error: "Legal document not found." });
    }

    const document = await LegalDocument.findOne({ key: req.params.key }).lean();
    if (document) {
      return res
        .set("Cache-Control", "no-store")
        .json({ item: { ...publicShape(document), isProvisional: false } });
    }

    if (req.params.key === "course-terms") {
      const draft = await CoursePolicy.findOne({ status: "draft" })
        .sort({ updatedAt: -1 })
        .lean();

      if (draft) {
        const normalizedDraft = normalizeCoursePolicy({
          ...draft,
          publishedAt: null,
          lastUpdated: draft.updatedAt,
        });
        return res
          .set("Cache-Control", "no-store")
          .json({ item: { ...normalizedDraft, isDraft: true } });
      }

      // Nothing saved yet: start the editor from the new built-in policy text,
      // so saving it publishes it (with a new checkout version).
      return res
        .set("Cache-Control", "no-store")
        .json({ item: { ...LEGAL_DOCUMENT_DEFAULTS["course-terms"], lastUpdated: null, isProvisional: true } });
    }

    return res
      .set("Cache-Control", "no-store")
      .json({
        item: {
          ...LEGAL_DOCUMENT_DEFAULTS[req.params.key],
          lastUpdated: null,
          isProvisional: true,
        },
      });
  } catch (error) {
    return next(error);
  }
}

function validatePayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Document content is invalid.";
  }

  const allowedKeys = ["title", "introduction", "sections"];
  if (Object.keys(body).some((key) => !allowedKeys.includes(key))) {
    return "Document contains unsupported fields.";
  }
  if (
    typeof body.title !== "string"
    || !body.title.trim()
    || body.title.trim().length > 160
  ) {
    return "Enter a title of no more than 160 characters.";
  }
  if (
    typeof body.introduction !== "string"
    || !body.introduction.trim()
    || body.introduction.trim().length > 4000
  ) {
    return "Enter an introduction of no more than 4,000 characters.";
  }
  if (
    !Array.isArray(body.sections)
    || body.sections.length < 1
    || body.sections.length > 20
  ) {
    return "Provide between 1 and 20 ordered sections.";
  }

  let totalCharacters = body.title.length + body.introduction.length;
  for (let index = 0; index < body.sections.length; index += 1) {
    const section = body.sections[index];
    const hasUnsupportedSectionKeys = section
      && typeof section === "object"
      && !Array.isArray(section)
      && Object.keys(section).some((key) => !["heading", "body", "order"].includes(key));

    if (
      !section
      || typeof section !== "object"
      || Array.isArray(section)
      || hasUnsupportedSectionKeys
    ) {
      return "A section contains unsupported fields.";
    }
    if (
      typeof section.heading !== "string"
      || !section.heading.trim()
      || section.heading.trim().length > 160
      || typeof section.body !== "string"
      || !section.body.trim()
      || section.body.trim().length > 5000
      || section.order !== index
    ) {
      return "Section heading, body or order is invalid.";
    }

    totalCharacters += section.heading.length + section.body.length;
  }

  if (totalCharacters > 60000) return "Document content is too large.";
  return "";
}

function contentSnapshot(value) {
  return JSON.stringify({
    title: value.title.trim(),
    introduction: value.introduction.trim(),
    sections: value.sections.map(({ heading, body }, order) => ({
      heading: heading.trim(),
      body: body.trim(),
      order,
    })),
  });
}

export async function saveAdminLegalDocument(req, res, next) {
  try {
    if (!validKey(req.params.key)) {
      return res.status(404).json({ error: "Legal document not found." });
    }

    const invalid = validatePayload(req.body);
    if (invalid) return res.status(400).json({ error: invalid });

    const data = {
      key: req.params.key,
      title: req.body.title.trim(),
      introduction: req.body.introduction.trim(),
      sections: req.body.sections.map(({ heading, body }, order) => ({
        heading: heading.trim(),
        body: body.trim(),
        order,
      })),
    };
    let document = await LegalDocument.findOne({ key: req.params.key });

    if (document && contentSnapshot(document) === contentSnapshot(data)) {
      return res
        .set("Cache-Control", "no-store")
        .json({
          item: {
            ...publicShape(document.toObject()),
            isProvisional: false,
          },
          unchanged: true,
        });
    }

    if (document) {
      document.set({
        ...data,
        revision: document.revision + 1,
        version: req.params.key === "course-terms"
          ? `course-terms-${document.revision + 1}`
          : document.version,
        updatedBy: req.admin.id,
      });
    } else {
      document = new LegalDocument({
        ...data,
        revision: 1,
        version: req.params.key === "course-terms" ? "course-terms-1" : "1",
        createdBy: new mongoose.Types.ObjectId(req.admin.id),
        updatedBy: new mongoose.Types.ObjectId(req.admin.id),
      });
    }

    const wasNew = document.isNew;
    await document.save();

    return res
      .status(wasNew ? 201 : 200)
      .set("Cache-Control", "no-store")
      .json({
        item: { ...publicShape(document.toObject()), isProvisional: false },
        unchanged: false,
      });
  } catch (error) {
    return next(error);
  }
}
