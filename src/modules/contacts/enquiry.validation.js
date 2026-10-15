
const ALLOWED_TYPES = new Set([
  "startup",
  "development",
  "workshop",
  "course",
  "internship",
  "career",
  "general",
]);

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "enquiryType",
  "sourcePage",
  "name",
  "email",
  "phone",
  "organisation",
  "city",
  "message",
  "enquirySpecificFields",
  "attachment",
  "timestamp",
]);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const REQUIRED_SPECIFIC_FIELDS = {
  startup: ["stage", "support"],
  development: ["build", "product", "budget"],
  workshop: ["topic", "format"],
  course: ["area", "level", "mode"],
  internship: ["department", "year", "area"],
  career: ["area", "level"],
  general: ["enquiry"],
};

const REQUIRED_ORGANISATION_TYPES = new Set(["workshop", "internship"]);
const REQUIRED_MULTIPLE_FIELDS = new Set(["support", "build", "topic"]);

const CONDITIONAL_OTHER_FIELDS = {
  startup: [{ trigger: "support", field: "supportOther" }],
  development: [{ trigger: "build", field: "buildOther" }],
  workshop: [{ trigger: "topic", field: "topicOther" }],
  course: [{ trigger: "area", field: "areaOther" }],
  internship: [{ trigger: "area", field: "areaOther" }],
  career: [
    { trigger: "area", field: "areaOther" },
    { trigger: "roleInterest", field: "roleInterestOther" },
  ],
  general: [{ trigger: "enquiry", field: "enquiryOther" }],
};

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function countWords(value) {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw badRequest(`Please provide ${label}.`);
  }
}

function requireMultipleChoice(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw badRequest(`Please choose at least one ${label}.`);
  }
}

function requireWordRange(value, minimum, maximum, label) {
  requireText(value, label);
  const words = countWords(value.trim());

  if (words < minimum || words > maximum) {
    throw badRequest(
      `${label[0].toUpperCase()}${label.slice(1)} must contain between ${minimum} and ${maximum} words.`
    );
  }
}

function validateRequiredFields(enquiryType, specificFields, answers) {
  if (REQUIRED_ORGANISATION_TYPES.has(enquiryType)) {
    requireText(answers.organisation, "your institution or college");
  }

  for (const field of REQUIRED_SPECIFIC_FIELDS[enquiryType]) {
    const value = specificFields[field];

    if (REQUIRED_MULTIPLE_FIELDS.has(field)) {
      requireMultipleChoice(value, field);
    } else {
      requireText(value, field);
    }
  }

  if (enquiryType === "career") {
    requireWordRange(specificFields.motivation, 20, 300, "your motivation");
  } else {
    requireWordRange(answers.message, 10, 500, "your message");
  }

  const conditionalOtherFields = CONDITIONAL_OTHER_FIELDS[enquiryType];

  for (const { trigger, field } of conditionalOtherFields) {
    const triggerValue = specificFields[trigger];
    const hasOther = Array.isArray(triggerValue)
      ? triggerValue.includes("Other")
      : triggerValue === "Other";

    if (hasOther) {
      requireWordRange(specificFields[field], 2, 100, `the ${field} details`);
    }
  }
}

function sanitizeValue(value, key = "", depth = 0) {
  if (depth > 5) {
    throw badRequest("The submission contains too many nested fields.");
  }

  if (typeof value === "string") {
    const cleaned = value.trim();

    if (cleaned.length > 10000) {
      throw badRequest("One of the fields is too long.");
    }

    if (key.toLowerCase().includes("email") && cleaned) {
      if (!EMAIL_REGEX.test(cleaned)) {
        throw badRequest("Please enter a valid email address.");
      }
    }

    if (
      key.toLowerCase().includes("message") &&
      countWords(cleaned) > 500
    ) {
      throw badRequest("The message cannot exceed 500 words.");
    }

    return cleaned;
  }

  if (value === null || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw badRequest("One of the fields contains an invalid number.");
    }

    return value;
  }

  if (Array.isArray(value)) {
    if (value.length > 30) {
      throw badRequest("One of the fields contains too many items.");
    }

    return value.map((item) => sanitizeValue(item, key, depth + 1));
  }

  if (value && typeof value === "object") {
    const result = {};

    for (const [childKey, childValue] of Object.entries(value)) {
      if (
        ["__proto__", "constructor", "prototype"].includes(childKey)
      ) {
        throw badRequest("The submission contains an invalid field.");
      }

      result[childKey] = sanitizeValue(
        childValue,
        childKey,
        depth + 1
      );
    }

    return result;
  }

  throw badRequest("One of the fields contains an unsupported value.");
}

export function validateEnquiryPayload(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw badRequest("Invalid submission. Please try again.");
  }

  for (const key of Object.keys(payload)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      throw badRequest("The form contains an unexpected field.");
    }
  }

  if (!ALLOWED_TYPES.has(payload.enquiryType)) {
    throw badRequest("Please select a valid enquiry category.");
  }

  if (
    payload.sourcePage !== undefined &&
    (typeof payload.sourcePage !== "string" ||
      payload.sourcePage.length > 100)
  ) {
    throw badRequest("Invalid source page.");
  }

  const specificFields = sanitizeValue(
    payload.enquirySpecificFields ?? {},
    "enquirySpecificFields"
  );

  if (
    !specificFields ||
    typeof specificFields !== "object" ||
    Array.isArray(specificFields)
  ) {
    throw badRequest("Invalid enquiry-specific fields.");
  }

  const name = sanitizeValue(payload.name ?? "", "name");
  const email = sanitizeValue(payload.email ?? "", "email");
  const phone = sanitizeValue(payload.phone ?? "", "phone");
  const organisation = sanitizeValue(
    payload.organisation ?? "",
    "organisation"
  );
  const city = sanitizeValue(payload.city ?? "", "city");
  const message = sanitizeValue(payload.message ?? "", "message");

  requireText(name, "your name");
  requireText(email, "your email address");
  requireText(phone, "your phone number");

  if (!EMAIL_REGEX.test(email)) {
    throw badRequest("Please enter a valid email address.");
  }

  const cleanedPhone = phone.replace(/[\s().-]/g, "");
  const isIndianNumber = /^(?:\+91|91|0)?[6-9]\d{9}$/.test(cleanedPhone);
  const isInternationalNumber = /^\+\d{7,15}$/.test(cleanedPhone);

  if (!isIndianNumber && !isInternationalNumber) {
    throw badRequest("Please enter a valid phone number.");
  }

  if (payload.enquiryType !== "career" && !message) {
    throw badRequest("Please enter your message.");
  }

  // Core contact fields take precedence over similarly named custom fields.
  const answers = {
    ...specificFields,
    name,
    email,
    phone,
    organisation,
    city,
    message,
  };

  validateRequiredFields(payload.enquiryType, specificFields, answers);

  return {
    enquiryType: payload.enquiryType,
    sourcePage:
      typeof payload.sourcePage === "string"
        ? payload.sourcePage.trim() || "contact"
        : "contact",
    answers,
  };
}
