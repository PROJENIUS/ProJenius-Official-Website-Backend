import assert from "node:assert/strict";
import test from "node:test";

import { validateEnquiryPayload } from "../src/modules/contacts/enquiry.validation.js";

const validMessage = "Please help us plan and understand this project in more detail.";
const validMotivation =
  "I want to contribute to practical projects, learn from experienced teammates, and build useful technology with your organization while growing my engineering and collaboration skills.";

function payload(enquiryType, enquirySpecificFields = {}, overrides = {}) {
  return {
    enquiryType,
    name: "Asha Example",
    email: "asha@example.com",
    phone: "+91 98765 43210",
    message: validMessage,
    enquirySpecificFields,
    ...overrides,
  };
}

const validSubmissions = [
  ["startup", { stage: "Prototype", support: ["IoT"] }],
  [
    "development",
    { build: ["Website / Web Application"], product: "New Product", budget: "Flexible" },
  ],
  [
    "workshop",
    { topic: ["Embedded Systems"], format: "One-Day Workshop" },
    { organisation: "Example College" },
  ],
  ["course", { area: "IoT", level: "Beginner", mode: "Online" }],
  [
    "internship",
    { department: "Computer Science", year: "3rd year", area: "Software Development" },
    { organisation: "Example College" },
  ],
  ["career", { area: "Robotics", level: "Beginner", motivation: validMotivation }],
  ["general", { enquiry: "General Enquiry" }],
];

test("accepts the current payload fields for all seven enquiry types", () => {
  for (const [type, fields, overrides = {}] of validSubmissions) {
    const result = validateEnquiryPayload(payload(type, fields, overrides));
    assert.equal(result.enquiryType, type);
    assert.equal(result.answers.email, "asha@example.com");
  }
});

test("requires every enquiry type's currently required specific fields", () => {
  for (const [type, fields, overrides = {}] of validSubmissions) {
    for (const key of Object.keys(fields)) {
      const incompleteFields = { ...fields };
      delete incompleteFields[key];

      assert.throws(
        () => validateEnquiryPayload(payload(type, incompleteFields, overrides)),
        { status: 400 },
        `${type} should require ${key}`
      );
    }
  }
});

test("accepts optional contact fields when omitted", () => {
  for (const [type, fields, overrides = {}] of validSubmissions) {
    assert.doesNotThrow(() =>
      validateEnquiryPayload(payload(type, fields, overrides))
    );
  }
});

test("requires organization for workshop and internship only", () => {
  for (const [type, fields, overrides = {}] of validSubmissions) {
    if (!["workshop", "internship"].includes(type)) continue;

    assert.throws(
      () => validateEnquiryPayload(payload(type, fields)),
      { status: 400 }
    );
  }
});

test("requires and validates conditional Other details when selected", () => {
  assert.throws(
    () =>
      validateEnquiryPayload(
        payload(
          "workshop",
          { topic: ["IoT", "Other"], format: "One-Day Workshop" },
          { organisation: "Example College" }
        )
      ),
    { status: 400 }
  );

  assert.doesNotThrow(() =>
    validateEnquiryPayload(
      payload(
        "workshop",
        { topic: ["IoT", "Other"], topicOther: "Computer vision systems", format: "One-Day Workshop" },
        { organisation: "Example College" }
      )
    )
  );
});

test("requires conditional Other text for each enquiry flow that exposes it", () => {
  const otherFields = {
    startup: [{ trigger: "support", field: "supportOther", multi: true }],
    development: [{ trigger: "build", field: "buildOther", multi: true }],
    workshop: [{ trigger: "topic", field: "topicOther", multi: true }],
    course: [{ trigger: "area", field: "areaOther" }],
    internship: [{ trigger: "area", field: "areaOther" }],
    career: [
      { trigger: "area", field: "areaOther" },
      { trigger: "roleInterest", field: "roleInterestOther", multi: true },
    ],
    general: [{ trigger: "enquiry", field: "enquiryOther" }],
  };

  for (const [type, fields, overrides = {}] of validSubmissions) {
    for (const { trigger, field, multi } of otherFields[type]) {
      const fieldsWithOther = { ...fields };
      fieldsWithOther[trigger] = multi
        ? [...(fieldsWithOther[trigger] || []), "Other"]
        : "Other";
      delete fieldsWithOther[field];

      assert.throws(
        () => validateEnquiryPayload(payload(type, fieldsWithOther, overrides)),
        { status: 400 },
        `${type} should require ${field} when ${trigger} is Other`
      );
    }
  }
});

test("enforces current message and phone requirements", () => {
  assert.throws(
    () => validateEnquiryPayload(payload("general", { enquiry: "General Enquiry" }, { message: "Too short" })),
    { status: 400 }
  );

  assert.throws(
    () => validateEnquiryPayload(payload("general", { enquiry: "General Enquiry" }, { phone: "123" })),
    { status: 400 }
  );
});

test("rejects missing core contact fields and malformed email addresses", () => {
  for (const field of ["name", "email", "phone"]) {
    const incomplete = payload("general", { enquiry: "General Enquiry" });
    delete incomplete[field];

    assert.throws(
      () => validateEnquiryPayload(incomplete),
      { status: 400 },
      `${field} should be required`
    );
  }

  assert.throws(
    () =>
      validateEnquiryPayload(
        payload("general", { enquiry: "General Enquiry" }, { email: "not-an-email" })
      ),
    { status: 400 }
  );
});

test("accepts international phone numbers and rejects malformed numbers", () => {
  assert.doesNotThrow(() =>
    validateEnquiryPayload(
      payload("general", { enquiry: "General Enquiry" }, { phone: "+442071838750" })
    )
  );

  for (const phone of ["123", "+12", "abcdefghij"]) {
    assert.throws(
      () =>
        validateEnquiryPayload(
          payload("general", { enquiry: "General Enquiry" }, { phone })
        ),
      { status: 400 },
      `${phone} should be rejected`
    );
  }
});

test("enforces message word-count boundaries", () => {
  const general = { enquiry: "General Enquiry" };
  const words = (count) => Array(count).fill("word").join(" ");

  for (const count of [10, 500]) {
    assert.doesNotThrow(() =>
      validateEnquiryPayload(payload("general", general, { message: words(count) }))
    );
  }

  for (const count of [9, 501]) {
    assert.throws(
      () =>
        validateEnquiryPayload(payload("general", general, { message: words(count) })),
      { status: 400 },
      `${count} message words should be rejected`
    );
  }
});

test("enforces career motivation word-count boundaries in payload validation", () => {
  const career = { area: "Robotics", level: "Beginner" };
  const words = (count) => Array(count).fill("word").join(" ");

  for (const count of [20, 300]) {
    assert.doesNotThrow(() =>
      validateEnquiryPayload(
        payload("career", { ...career, motivation: words(count) })
      )
    );
  }

  for (const count of [19, 301]) {
    assert.throws(
      () =>
        validateEnquiryPayload(
          payload("career", { ...career, motivation: words(count) })
        ),
      { status: 400 },
      `${count} motivation words should be rejected`
    );
  }
});

test("enforces conditional Other details word-count boundaries", () => {
  const validFields = { topic: ["Other"], format: "One-Day Workshop" };
  const words = (count) => Array(count).fill("word").join(" ");

  for (const count of [2, 100]) {
    assert.doesNotThrow(() =>
      validateEnquiryPayload(
        payload(
          "workshop",
          { ...validFields, topicOther: words(count) },
          { organisation: "Example College" }
        )
      )
    );
  }

  for (const count of [1, 101]) {
    assert.throws(
      () =>
        validateEnquiryPayload(
          payload(
            "workshop",
            { ...validFields, topicOther: words(count) },
            { organisation: "Example College" }
          )
        ),
      { status: 400 },
      `${count} Other-detail words should be rejected`
    );
  }
});

test("does not require career organization or optional answers", () => {
  const career = validSubmissions.find(([type]) => type === "career");
  assert.doesNotThrow(() => validateEnquiryPayload(payload(career[0], career[1])));
});
