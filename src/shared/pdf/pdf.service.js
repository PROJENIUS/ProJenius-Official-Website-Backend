import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMPANY = {
  name: "ProJenius Innovation Technology Private Limited",
  website: "projenius.in",
  phone: "8925450473",
  address: "Plot No. 3, Velmurugan Nagar, Erikarai Street, Madurai - 625016",
};

const COLORS = {
  navy: "#0A347F",
  cyan: "#08B8D0",
  text: "#202938",
  muted: "#64748B",
  border: "#DCE5EF",
  pale: "#F2F8FC",
};

const PAGE = {
  width: 595.28,
  height: 841.89,
  left: 48,
  right: 547.28,
  bodyTop: 166,
  footerLine: 757,
  footerNote: 768,
  footerContact: 784,
};

const CORE_FIELDS = ["name", "email", "phone", "organisation", "city"];
const PRIVATE_FIELD = /password|session|secret|token|authorization|resume|attachment|storedname|filepath/i;
const DEFAULT_LOGO_PATH = path.resolve(
  process.env.COMPANY_LOGO_PATH || "./assets/projenius-logo.png"
);
const UNICODE_FONT_NAME = "ProJeniusUnicode";
const SERVICE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const UNICODE_FONT_CANDIDATES = [
  process.env.PDF_UNICODE_FONT_PATH,
  path.resolve(SERVICE_DIRECTORY, "../../../assets/NotoSans-Regular.ttf"),
  "C:/Windows/Fonts/arial.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];
const documentsWithUnicodeFont = new WeakSet();

function findUnicodeFontPath() {
  return UNICODE_FONT_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate));
}

function cleanText(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    return Object.entries(value)
      .filter(([key]) => !PRIVATE_FIELD.test(key))
      .map(([key, item]) => {
        const child = cleanText(item);
        return child ? `${readableLabel(key)}: ${child}` : "";
      })
      .filter(Boolean)
      .join("; ");
  }
  return String(value).trim();
}

function readableLabel(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatCategory(enquiryType, isJobApplication) {
  if (isJobApplication) return "Career application";
  return readableLabel(enquiryType || "Enquiry");
}

function writeFixedText(doc, text, x, y, {
  font = "Helvetica",
  size = 9,
  color = COLORS.text,
  align = "left",
  width,
} = {}) {
  const content = String(text ?? "");
  doc.font(font).fontSize(size).fillColor(color);
  let textX = x;
  const textWidth = doc.widthOfString(content);

  if (width && align === "center") textX += Math.max(0, (width - textWidth) / 2);
  if (width && align === "right") textX += Math.max(0, width - textWidth);

  // No width is passed: fixed header/footer text cannot trigger PDFKit pagination.
  doc.text(content, textX, y, { lineBreak: false });
}

function drawHeader(doc, title) {
  const originalX = doc.x;
  const originalY = doc.y;
  const x = PAGE.left;
  const logoPath = DEFAULT_LOGO_PATH;
  const hasLogo = fs.existsSync(logoPath);
  const wordmarkX = hasLogo ? x + 92 : x;

  if (hasLogo) {
    doc.image(logoPath, x, 30, { fit: [76, 58], align: "left", valign: "center" });
  }

  writeFixedText(doc, "ProJenius", wordmarkX, 31, {
    font: "Helvetica-Bold", size: 17, color: COLORS.navy,
  });
  writeFixedText(doc, COMPANY.name, wordmarkX, 54, {
    font: "Helvetica-Bold", size: 9, color: COLORS.text,
  });
  writeFixedText(doc, `${COMPANY.website}  |  ${COMPANY.address}`, wordmarkX, 69, {
    size: 7.5, color: COLORS.muted,
  });

  doc.moveTo(x, 96).lineTo(PAGE.right, 96)
    .lineWidth(1.3).strokeColor(COLORS.cyan).stroke();

  writeFixedText(doc, title, x, 111, {
    font: "Helvetica-Bold", size: 16, color: COLORS.navy,
  });
  writeFixedText(doc, "OFFICIAL SUBMISSION CONFIRMATION", x, 135, {
    font: "Helvetica-Bold", size: 8, color: COLORS.muted,
  });

  doc.x = originalX;
  doc.y = originalY;
}

function drawFooter(doc, pageNumber, totalPages) {
  const originalX = doc.x;
  const originalY = doc.y;
  const contentWidth = PAGE.right - PAGE.left;

  doc.moveTo(PAGE.left, PAGE.footerLine).lineTo(PAGE.right, PAGE.footerLine)
    .lineWidth(0.65).strokeColor(COLORS.border).stroke();

  writeFixedText(
    doc,
    "This is a system-generated receipt. No physical signature is required.",
    PAGE.left,
    PAGE.footerNote,
    { size: 7.5, color: COLORS.muted }
  );
  writeFixedText(
    doc,
    `${COMPANY.website}  |  ${COMPANY.phone}`,
    PAGE.left,
    PAGE.footerContact,
    { font: "Helvetica-Bold", size: 8, color: COLORS.navy }
  );
  if (totalPages > 1) {
    writeFixedText(doc, `Page ${pageNumber} of ${totalPages}`, PAGE.left, PAGE.footerContact, {
      size: 7.5, color: COLORS.muted, align: "right", width: contentWidth,
    });
  }

  doc.x = originalX;
  doc.y = originalY;
}

function ensureRoom(doc, height) {
  const available = doc.page.maxY() - doc.y;
  if (height <= available) return;
  if (height > doc.page.maxY() - doc.page.margins.top) return;
  doc.addPage();
}

function addSectionHeading(doc, heading) {
  ensureRoom(doc, 30);
  doc.moveDown(0.35);
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor(COLORS.navy)
    .text(heading, PAGE.left, doc.y, { width: PAGE.right - PAGE.left });
  doc.moveDown(0.3);
  doc.moveTo(PAGE.left, doc.y).lineTo(PAGE.right, doc.y)
    .lineWidth(0.45).strokeColor(COLORS.border).stroke();
  doc.moveDown(0.35);
}

function splitLongTokens(doc, value, width, font, fontSize) {
  const text = String(value ?? "");
  const words = text.split(/(\s+)/u);
  return words.map((word) => {
    if (!word || /^\s+$/u.test(word) || doc.widthOfString(word, { font, fontSize }) <= width) {
      return word;
    }

    const pieces = [];
    let piece = "";
    for (const character of Array.from(word)) {
      const candidate = piece + character;
      if (piece && doc.widthOfString(candidate, { font, fontSize }) > width) {
        pieces.push(piece);
        piece = character;
      } else {
        piece = candidate;
      }
    }
    if (piece) pieces.push(piece);
    return pieces.join("\n");
  }).join("");
}

function addField(doc, label, rawValue) {
  const value = cleanText(rawValue);
  if (!value) return;

  const labelX = PAGE.left;
  const labelWidth = 138;
  const valueX = labelX + labelWidth + 12;
  const valueWidth = PAGE.right - valueX;
  const labelText = readableLabel(label);
  const labelFont = "Helvetica-Bold";
  const valueFont = value.includes("₹") ? UNICODE_FONT_NAME : "Helvetica";
  const labelSize = 7.5;
  const fontSize = 9.25;
  if (valueFont === UNICODE_FONT_NAME) {
    const unicodeFontPath = findUnicodeFontPath();
    if (!unicodeFontPath) {
      throw new Error("A Unicode-capable font is required to render the rupee symbol in the PDF receipt.");
    }
    if (!documentsWithUnicodeFont.has(doc)) {
      doc.registerFont(UNICODE_FONT_NAME, unicodeFontPath);
      documentsWithUnicodeFont.add(doc);
    }
  }
  doc.font(valueFont).fontSize(fontSize);
  const wrappedValue = splitLongTokens(doc, value, valueWidth, valueFont, fontSize);
  const labelHeight = doc.heightOfString(labelText, {
    width: valueWidth, font: labelFont, fontSize: labelSize,
  });
  const valueHeight = doc.heightOfString(wrappedValue, {
    width: valueWidth, font: valueFont, fontSize, lineGap: 2,
  });
  const rowHeight = Math.max(labelHeight, valueHeight) + 8;
  ensureRoom(doc, rowHeight);

  const startY = doc.y;
  doc.font(labelFont).fontSize(labelSize).fillColor(COLORS.muted)
    .text(labelText, labelX, startY, { width: labelWidth });
  doc.font(valueFont).fontSize(fontSize).fillColor(COLORS.text)
    .text(wrappedValue, valueX, startY, { width: valueWidth, lineGap: 1.5 });
  doc.y = Math.max(doc.y, startY + labelHeight) + 7;
}

function flattenFields(answers = {}) {
  const fields = [];
  const visit = (value, key) => {
    if (PRIVATE_FIELD.test(key)) return;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
      return;
    }
    const text = cleanText(value);
    if (text) fields.push([key, text]);
  };

  for (const [key, value] of Object.entries(answers || {})) visit(value, key);
  return fields;
}

function formatDate(createdAt) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return date.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });
}

function addReferenceCard(doc, referenceNumber) {
  ensureRoom(doc, 67);
  const x = PAGE.left;
  const y = doc.y + 3;
  const width = PAGE.right - PAGE.left;

  doc.roundedRect(x, y, width, 55, 7)
    .fillAndStroke(COLORS.pale, COLORS.border);
  doc.rect(x, y, 4, 55).fill(COLORS.cyan);
  writeFixedText(doc, "REFERENCE NUMBER", x + 17, y + 10, {
    font: "Helvetica-Bold", size: 7.5, color: COLORS.muted,
  });
  writeFixedText(doc, referenceNumber, x + 17, y + 26, {
    font: "Helvetica-Bold", size: 14, color: COLORS.navy,
  });
  doc.y = y + 67;
}

function buildSubmissionContent(doc, details) {
  const {
    referenceNumber,
    enquiryType,
    sourcePage,
    answers,
    createdAt,
    isJobApplication,
    attachmentName,
  } = details;

  doc.font("Helvetica").fontSize(9.5).fillColor(COLORS.text)
    .text(
      "This receipt confirms that ProJenius has received and recorded your submission.",
      PAGE.left,
      doc.y,
      { width: PAGE.right - PAGE.left, lineGap: 2 }
    );
  doc.moveDown(0.45);

  addReferenceCard(doc, referenceNumber);
  addSectionHeading(doc, "Reference details");
  addField(doc, "Submission category", formatCategory(enquiryType, isJobApplication));
  addField(doc, "Submitted on", formatDate(createdAt));
  if (sourcePage) addField(doc, "Source page", sourcePage);

  const fields = flattenFields(answers);
  const coreFields = fields.filter(([key]) => CORE_FIELDS.includes(key.toLowerCase()));
  const otherFields = fields.filter(([key]) => !CORE_FIELDS.includes(key.toLowerCase()) && key.toLowerCase() !== "message");
  const message = fields.find(([key]) => key.toLowerCase() === "message")?.[1];

  if (coreFields.length) {
    addSectionHeading(doc, "Contact details");
    for (const [key, value] of coreFields) addField(doc, key, value);
  }

  if (otherFields.length) {
    addSectionHeading(doc, "Enquiry details");
    for (const [key, value] of otherFields) addField(doc, key, value);
  }

  if (message) {
    addSectionHeading(doc, "Message");
    addField(doc, "Submitted message", message);
  }

  if (attachmentName) {
    addSectionHeading(doc, "Attached document");
    addField(doc, isJobApplication ? "Resume" : "Attachment", attachmentName);
  }

  ensureRoom(doc, 40);
  doc.moveDown(0.6);
  doc.font("Helvetica").fontSize(8.5).fillColor(COLORS.muted)
    .text(
      "Please retain this receipt and quote the reference number when contacting our team about this submission.",
      PAGE.left,
      doc.y,
      { width: PAGE.right - PAGE.left, lineGap: 2 }
    );
}

export function generateSubmissionPdf(details, { compress = true } = {}) {
  return new Promise((resolve, reject) => {
    let doc;
    try {
      const isJobApplication = details.isJobApplication === true;
      const title = isJobApplication
        ? "JOB APPLICATION RECEIPT"
        : "ENQUIRY SUBMISSION RECEIPT";

      doc = new PDFDocument({
        size: "A4",
        margins: { top: PAGE.bodyTop, bottom: 112, left: PAGE.left, right: 48 },
        bufferPages: true,
        autoFirstPage: true,
        compress,
        info: {
          Title: `ProJenius Submission ${details.referenceNumber}`,
          Author: COMPANY.name,
          Subject: "Official submission confirmation",
        },
      });

      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.once("error", reject);
      doc.once("end", () => resolve(Buffer.concat(chunks)));
      doc.on("pageAdded", () => drawHeader(doc, title));

      drawHeader(doc, title);
      buildSubmissionContent(doc, { ...details, isJobApplication });

      const range = doc.bufferedPageRange();
      for (let index = 0; index < range.count; index += 1) {
        doc.switchToPage(range.start + index);
        drawFooter(doc, index + 1, range.count);
      }

      if (doc.bufferedPageRange().count !== range.count) {
        throw new Error("PDF footer changed the generated page count.");
      }

      // Finalise the document exactly once after all buffered pages are stamped.
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
