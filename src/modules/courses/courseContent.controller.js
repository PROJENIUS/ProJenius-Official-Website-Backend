import mongoose from "mongoose";
import LegalDocument from "../legal/legalDocument.model.js";
import CourseCommonFaq from "./courseCommonFaq.model.js";
import CoursePolicy from "./coursePolicy.model.js";

const POLICY_SECTIONS = [
  "general",
  "registration",
  "subscription",
  "refunds",
  "privacy",
  "cookies",
  "delivery",
  "support",
];

const POLICY_TITLES = {
  general: "General Terms of Use",
  registration: "Course Registration & Payments",
  subscription: "Subscription Terms",
  refunds: "Cancellation & Refund Policy",
  privacy: "Privacy Policy",
  cookies: "Cookie Policy",
  delivery: "Course Delivery & Certificates",
  support: "Contact & Support",
};

const DEFAULT_TERMS_VERSION = process.env.COURSE_TERMS_VERSION?.trim()
  || "live-training-v2";
const DEFAULT_TERMS_POLICY = "Please review the programme details, delivery mode, schedule and fees carefully before payment. The registration fee is non-refundable for participant cancellation, non-attendance or a change of personal plans. Batch-change requests are subject to availability and written approval and are not guaranteed. If ProJenius cancels a programme or cannot provide the purchased service, we will address the matter under the applicable cancellation policy and law. Verified duplicate or erroneous charges will be investigated. A registration rejection does not itself mean a refund has been issued; any refund is handled separately and only after review. Payment-provider disputes and any refund required by applicable law will be handled in accordance with applicable requirements. Nothing in these terms removes rights that cannot legally be waived. Your contact details are used to process payment, registration and support. The schedule or venue may change; material updates will be communicated. This policy requires appropriate legal review before production use.";

function fail(res, status, error) {
  return res.status(status).json({ error });
}

function policyInput(input, { publishing = false } = {}) {
  if (
    !input
    || !Array.isArray(input.sections)
    || input.sections.length !== POLICY_SECTIONS.length
  ) {
    throw Object.assign(new Error("Provide all eight policy sections."), {
      status: 400,
    });
  }

  return input.sections.map((section, index) => {
    const isValid = section
      && section.key === POLICY_SECTIONS[index]
      && typeof section.content === "string"
      && !(publishing && !section.content.trim())
      && section.content.length <= 5000;

    if (!isValid) {
      throw Object.assign(
        new Error("Policy sections are invalid or out of order."),
        { status: 400 },
      );
    }

    return {
      key: section.key,
      title: POLICY_TITLES[section.key],
      content: section.content.trim(),
      order: index,
    };
  });
}

function legacyPolicyItem() {
  const policy = (
    process.env.COURSE_TERMS_POLICY?.trim() || DEFAULT_TERMS_POLICY
  ).slice(0, 4000);

  return {
    version: DEFAULT_TERMS_VERSION,
    policy,
    sections: [{
      key: "general",
      title: "General Terms of Use",
      content: policy,
      order: 0,
    }],
    publishedAt: null,
    isProvisional: true,
  };
}

export async function getCurrentCoursePolicy() {
  const legalDocument = await LegalDocument.findOne({
    key: "course-terms",
  }).lean();

  if (legalDocument) {
    const sections = legalDocument.sections.map((section, index) => ({
      key: `legal-${index + 1}`,
      title: section.heading,
      content: section.body,
      heading: section.heading,
      body: section.body,
      order: section.order,
    }));

    return {
      key: "course-terms",
      version: legalDocument.version || `course-terms-${legalDocument.revision}`,
      title: legalDocument.title,
      introduction: legalDocument.introduction,
      sections,
      policy: sections.map((section) => section.content).join("\n\n"),
      publishedAt: legalDocument.updatedAt,
      isProvisional: false,
    };
  }

  const policy = await CoursePolicy.findOne({ status: "published" })
    .sort({ publishedAt: -1, _id: -1 })
    .select("version sections publishedAt")
    .lean();

  return policy
    ? {
      ...policy,
      policy: policy.sections.map((section) => section.content).join("\n\n"),
      isProvisional: false,
    }
    : legacyPolicyItem();
}

export async function publicCoursePolicy(_req, res, next) {
  try {
    const item = await getCurrentCoursePolicy();
    return res.set("Cache-Control", "no-store").json({ item });
  } catch (error) {
    return next(error);
  }
}

export async function listCourseCommonFaqs(_req, res, next) {
  try {
    const items = await CourseCommonFaq.find({ published: true })
      .select("question answer order")
      .sort({ order: 1, _id: 1 })
      .lean();

    return res
      .set("Cache-Control", "public, max-age=60")
      .json({ items });
  } catch (error) {
    return next(error);
  }
}

export async function adminListCourseCommonFaqs(_req, res, next) {
  try {
    const items = await CourseCommonFaq.find()
      .sort({ order: 1, _id: 1 })
      .lean();
    return res.json({ items });
  } catch (error) {
    return next(error);
  }
}

export async function saveCourseCommonFaq(req, res, next) {
  try {
    const {
      question,
      answer,
      order = 0,
      published = false,
    } = req.body || {};
    const isInvalid = typeof question !== "string"
      || !question.trim()
      || question.trim().length > 300
      || typeof answer !== "string"
      || !answer.trim()
      || answer.trim().length > 1500
      || !Number.isSafeInteger(order)
      || order < 0
      || typeof published !== "boolean";

    if (isInvalid) {
      return fail(res, 400, "FAQ question, answer, order or status is invalid.");
    }

    let item;
    if (req.params.id) {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return fail(res, 400, "FAQ ID is invalid.");
      }

      item = await CourseCommonFaq.findById(req.params.id);
      if (!item) return fail(res, 404, "FAQ not found.");

      item.set({
        question: question.trim(),
        answer: answer.trim(),
        order,
        published,
        updatedBy: req.admin.id,
      });
      await item.save();
    } else {
      item = await CourseCommonFaq.create({
        question: question.trim(),
        answer: answer.trim(),
        order,
        published,
        createdBy: req.admin.id,
        updatedBy: req.admin.id,
      });
    }

    return res.status(req.params.id ? 200 : 201).json({ item });
  } catch (error) {
    return next(error);
  }
}

export async function deleteCourseCommonFaq(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return fail(res, 400, "FAQ ID is invalid.");
    }

    const item = await CourseCommonFaq.findByIdAndDelete(req.params.id);
    return item ? res.sendStatus(204) : fail(res, 404, "FAQ not found.");
  } catch (error) {
    return next(error);
  }
}

export async function adminGetCoursePolicy(_req, res, next) {
  try {
    const legalDocument = await LegalDocument.findOne({
      key: "course-terms",
    }).lean();

    if (legalDocument) {
      const published = {
        _id: legalDocument._id,
        version: legalDocument.version,
        status: "published",
        publishedAt: legalDocument.updatedAt,
        sections: legalDocument.sections.map((section, order) => ({
          key: `legal-${order + 1}`,
          title: section.heading,
          content: section.body,
          order,
        })),
      };

      return res
        .set("Cache-Control", "no-store")
        .json({ draft: null, published });
    }

    const [draft, published] = await Promise.all([
      CoursePolicy.findOne({ status: "draft" })
        .sort({ updatedAt: -1 })
        .lean(),
      CoursePolicy.findOne({ status: "published" })
        .sort({ publishedAt: -1, _id: -1 })
        .lean(),
    ]);

    return res.json({ draft, published });
  } catch (error) {
    return next(error);
  }
}

export async function saveCoursePolicyDraft(req, res, next) {
  try {
    const legalDocumentExists = await LegalDocument.exists({
      key: "course-terms",
    });
    if (legalDocumentExists) {
      return fail(
        res,
        409,
        "Course terms are managed in the Legal Pages editor.",
      );
    }

    const sections = policyInput(req.body);
    const draft = await CoursePolicy.findOne({ status: "draft" })
      .sort({ updatedAt: -1 });

    if (draft) {
      draft.sections = sections;
      draft.updatedBy = req.admin.id;
      await draft.save();
      return res.json({ item: draft });
    }

    const version = typeof req.body.version === "string" && req.body.version.trim()
      ? req.body.version.trim().slice(0, 80)
      : `policy-${new Date().toISOString().slice(0, 10)}`;

    const item = await CoursePolicy.create({
      version,
      sections,
      status: "draft",
      createdBy: req.admin.id,
      updatedBy: req.admin.id,
    });

    return res.status(201).json({ item });
  } catch (error) {
    return error.status
      ? fail(res, error.status, error.message)
      : next(error);
  }
}

export async function publishCoursePolicy(req, res, next) {
  try {
    const legalDocumentExists = await LegalDocument.exists({
      key: "course-terms",
    });
    if (legalDocumentExists) {
      return fail(
        res,
        409,
        "Course terms are managed in the Legal Pages editor.",
      );
    }

    const sections = policyInput(req.body, { publishing: true });
    const version = typeof req.body.version === "string" && req.body.version.trim()
      ? req.body.version.trim().slice(0, 80)
      : `policy-${new Date().toISOString().slice(0, 10)}`;
    const item = await CoursePolicy.create({
      version,
      sections,
      status: "published",
      publishedAt: new Date(),
      createdBy: req.admin.id,
      updatedBy: req.admin.id,
    });

    await CoursePolicy.updateMany(
      { _id: { $ne: item._id }, status: "draft" },
      { $set: { status: "draft" } },
    );

    return res.status(201).json({ item });
  } catch (error) {
    return error.status
      ? fail(res, error.status, error.message)
      : next(error);
  }
}

export { POLICY_SECTIONS, POLICY_TITLES };
