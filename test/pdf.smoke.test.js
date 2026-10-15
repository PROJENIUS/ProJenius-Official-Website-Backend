import assert from "node:assert/strict";
import test from "node:test";

import { generateSubmissionPdf } from "../src/shared/pdf/index.js";

const REFERENCE = "PJ-ENQ-20261014-ABCDEF12";
const FOOTER_NOTE = "This is a system-generated receipt. No physical signature is required.";
const FOOTER_CONTACT = "projenius.in";

function decodePdfHex(hex) {
  const bytes = Buffer.from(hex, "hex");
  const cp1252 = ["€", "", "‚", "ƒ", "„", "…", "†", "‡", "ˆ", "‰", "Š", "‹", "Œ", "", "Ž", "", "", "‘", "’", "“", "”", "•", "–", "—", "˜", "™", "š", "›", "œ", "", "ž", "Ÿ"];
  return [...bytes].map((byte) => byte >= 0x80 && byte <= 0x9f ? cp1252[byte - 0x80] : String.fromCharCode(byte)).join("");
}

function extractPageData(pdf) {
  const source = pdf.toString("latin1");
  const objects = new Map();
  for (const match of source.matchAll(/(?:^|\n)(\d+) 0 obj\s*([\s\S]*?)endobj/g)) {
    objects.set(Number(match[1]), match[2]);
  }
  const pages = [];
  for (const [id, object] of objects) {
    if (!/\/Type \/Page\b/.test(object)) continue;
    const mediaBox = object.match(/\/MediaBox\s*\[([^\]]+)\]/)?.[1];
    const contents = [...object.matchAll(/(\d+) 0 R/g)].map((match) => Number(match[1]));
    const stream = contents.map((contentId) => objects.get(contentId)).find((candidate) => candidate?.includes("stream"));
    assert.ok(stream, `page object ${id} should have a content stream`);
    const streamData = stream.match(/stream\r?\n([\s\S]*?)\r?\nendstream/)?.[1];
    assert.ok(streamData, `page object ${id} stream should be present`);
    assert.equal(stream.includes("/FlateDecode"), false, "test PDF must remain uncompressed for structural inspection");
    const text = [...streamData.matchAll(/BT([\s\S]*?)ET/g)]
      .map((block) => [...block[1].matchAll(/<([0-9a-fA-F]+)>/g)].map((match) => decodePdfHex(match[1])).join(""))
      .join("\n");
    pages.push({ mediaBox, text });
  }
  return pages;
}

function baseDetails(overrides = {}) {
  return {
    referenceNumber: REFERENCE,
    enquiryType: "general",
    sourcePage: "contact",
    createdAt: new Date("2026-10-14T10:00:00.000Z"),
    answers: {
      name: "Synthetic PDF Applicant",
      email: "pdf-test@example.invalid",
      phone: "+91 98765 43210",
      city: "Test City",
      enquirySpecificFields: { enquiry: "General Enquiry" },
      message: "Please contact me about the service and explain the next steps for this enquiry.",
    },
    ...overrides,
  };
}

test("normal receipt is one-page A4 and includes the actual reference and footer", async () => {
  const pdf = await generateSubmissionPdf(baseDetails(), { compress: false });
  assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
  const pages = extractPageData(pdf);
  assert.equal(pages.length, 1);
  assert.match(pages[0].mediaBox, /595\.28\s+841\.89/);
  for (const expected of [REFERENCE, "ENQUIRY SUBMISSION RECEIPT", "Synthetic PDF Applicant", FOOTER_NOTE, FOOTER_CONTACT, "8925450473"]) {
    assert.ok(pages[0].text.includes(expected), `one-page receipt should include ${expected}`);
  }
  assert.equal(pages[0].text.includes("Page 1 of 1"), false);
  assert.equal(pages[0].text.includes("must-not-appear"), false);
  assert.ok(pages[0].text.indexOf(FOOTER_NOTE) > pages[0].text.indexOf("Please retain this receipt"));
  assert.ok(pages[0].text.lastIndexOf(FOOTER_CONTACT) > pages[0].text.indexOf(FOOTER_NOTE));
});

test("renders Indian rupee values with an embedded Unicode font and stays on one A4 page", async () => {
  const budget = "\u20b915,000\u2013\u20b950,000";
  const pdf = await generateSubmissionPdf(baseDetails({
    enquiryType: "development",
    answers: { ...baseDetails().answers, enquirySpecificFields: { budget } },
  }), { compress: false });
  const source = pdf.toString("latin1");
  const pages = extractPageData(pdf);
  assert.equal(pages.length, 1);
  assert.match(pages[0].mediaBox, /595\.28\s+841\.89/);
  assert.ok(source.includes("/ToUnicode"), "the Unicode font should include a character map");
  assert.ok(source.toLowerCase().includes("20b9"), "the font map should include U+20B9 rupee");
  assert.ok(source.includes("/BaseFont /") && source.includes("/Encoding /Identity-H"));
  assert.ok(pages[0].text.includes(FOOTER_NOTE) && pages[0].text.includes(FOOTER_CONTACT));
});

test("all seven enquiry types and career receipt render actual saved details", async () => {
  const cases = [
    ["startup", { stage: "Prototype", support: "IoT" }],
    ["development", { build: "Website", product: "Synthetic product", budget: "Flexible" }],
    ["workshop", { topic: "Embedded systems", format: "One day" }],
    ["course", { area: "IoT", level: "Beginner", mode: "Online" }],
    ["internship", { department: "Computer science", year: "Third year", area: "Software" }],
    ["career", { area: "Robotics", level: "Beginner", motivation: "I want to learn and contribute to practical projects with a collaborative team." }],
    ["general", { enquiry: "General enquiry" }],
  ];
  for (const [enquiryType, enquirySpecificFields] of cases) {
    const isJobApplication = enquiryType === "career";
    const pages = extractPageData(await generateSubmissionPdf(baseDetails({
      referenceNumber: `PJ-${isJobApplication ? "JOB" : "ENQ"}-20261014-ABCDEF12`,
      enquiryType,
      isJobApplication,
      attachmentName: isJobApplication ? "synthetic-resume.pdf" : undefined,
      answers: { ...baseDetails().answers, enquirySpecificFields },
    }), { compress: false }));
    assert.equal(pages.length, 1, `${enquiryType} should fit on one page with short synthetic values`);
    assert.ok(pages[0].text.includes(isJobApplication ? "JOB APPLICATION RECEIPT" : "ENQUIRY SUBMISSION RECEIPT"));
    assert.ok(pages[0].text.includes(enquiryType === "career" ? "PJ-JOB-" : "PJ-ENQ-"));
    assert.ok(pages[0].text.includes(enquirySpecificFields[Object.keys(enquirySpecificFields)[0]]));
    if (isJobApplication) assert.ok(pages[0].text.includes("synthetic-resume.pdf"));
  }
});

test("optional fields are omitted and special or long values are preserved", async () => {
  const special = "Café — € & 50% ™";
  const longEmail = `${"long-segment".repeat(12)}@example.invalid`;
  const pages = extractPageData(await generateSubmissionPdf(baseDetails({
    answers: {
      name: special,
      email: longEmail,
      phone: "+91 98765 43210",
      organisation: "",
      city: "",
      message: "A synthetic message with special symbols: " + special,
      password: "must-not-appear",
      sessionToken: "must-not-appear",
    },
  }), { compress: false }));
  assert.equal(pages.length, 1);
  assert.ok(pages[0].text.includes(special));
  assert.ok(pages[0].text.replace(/\s+/gu, "").includes(longEmail));
  assert.equal(pages[0].text.includes("must-not-appear"), false);
  assert.equal(pages[0].text.includes("Organisation"), false);
});

test("long content flows across pages with a header and footer on every page", async () => {
  const repeated = "This synthetic paragraph checks readable wrapping, complete body flow, and consistent page furniture. ".repeat(230);
  const pdf = await generateSubmissionPdf(baseDetails({
    answers: { ...baseDetails().answers, message: repeated },
  }), { compress: false });
  const pages = extractPageData(pdf);
  assert.ok(pages.length > 1, "long synthetic content should span multiple pages");
  const allText = pages.map((page) => page.text).join("\n");
  assert.ok(allText.includes(REFERENCE));
  assert.ok(allText.includes("This synthetic paragraph checks"));
  for (const [index, page] of pages.entries()) {
    assert.ok(page.text.includes("ENQUIRY SUBMISSION RECEIPT"), `page ${index + 1} should repeat the header`);
    assert.ok(page.text.includes(FOOTER_NOTE), `page ${index + 1} should repeat the footer note`);
    assert.ok(page.text.includes(FOOTER_CONTACT), `page ${index + 1} should repeat the company footer`);
    assert.ok(page.text.includes(`Page ${index + 1} of ${pages.length}`), `page ${index + 1} should be numbered`);
    assert.ok(page.text.replaceAll(FOOTER_NOTE, "").trim().length > 80, `page ${index + 1} must not be footer-only`);
  }
  assert.equal((allText.match(/ENQUIRY SUBMISSION RECEIPT/g) || []).length, pages.length);
});
