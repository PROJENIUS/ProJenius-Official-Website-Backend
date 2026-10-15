import PDFDocument from "pdfkit";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import CourseReceipt from "./courseReceipt.model.js";

const PRIVATE_UPLOAD_ROOT = path.resolve(process.env.PRIVATE_UPLOAD_DIR || "./private_uploads");
const RECEIPT_ROOT = path.resolve(process.env.COURSE_RECEIPT_STORAGE_DIR || path.join(PRIVATE_UPLOAD_ROOT, "course_receipts"));
const LEGACY_RECEIPT_ROOT = path.resolve(process.cwd(), "private_uploads", "course_receipts");

async function readReceipt(filename) {
  if (!/^[a-f\d-]{36}\.pdf$/i.test(filename)) throw new Error("Receipt file not found.");
  for (const root of [RECEIPT_ROOT, LEGACY_RECEIPT_ROOT]) {
    try { return await fs.readFile(path.join(root, filename)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  throw new Error("The stored receipt file is unavailable.");
}

const company = {
  name: "ProJenius Innovation Technology Private Limited",
  address: "Plot No. 3, Velmurugan Nagar, Erikarai Street, Madurai - 625016",
  website: "projenius.in",
  phone: "8925450473",
};

export function generateCourseReceipt(details) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 54, info: { Title: `ProJenius Course Receipt ${details.reference}`, Author: company.name } });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("error", reject);
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.fillColor("#0A347F").fontSize(22).font("Helvetica-Bold").text("ProJenius", { align: "left" });
      doc.fillColor("#64748B").fontSize(9).font("Helvetica").text(company.name);
      doc.moveDown(2);
      doc.fillColor("#0A347F").fontSize(19).font("Helvetica-Bold").text("COURSE PAYMENT RECEIPT");
      doc.moveDown(1.4);
      const rows = [
        ["Enrolment reference", details.reference], ["Payment status", "PAID · VERIFIED"],
        ["Student", details.student.name], ["Student email", details.student.email],
        ["Course", details.courseTitle], ["Purchase date", new Date(details.paidAt || Date.now()).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })],
        ["Amount paid", `INR ${(details.amountMinor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`],
        ["Payment reference", details.paymentId],
      ];
      for (const [label, value] of rows) {
        doc.fillColor("#64748B").font("Helvetica-Bold").fontSize(9).text(label.toUpperCase());
        doc.fillColor("#202938").font("Helvetica").fontSize(12).text(String(value || "—"), { width: 475 });
        doc.moveDown(0.8);
      }
      doc.moveDown(1);
      doc.fillColor("#64748B").fontSize(9).text("This receipt confirms a payment verified by the ProJenius payment service.", { width: 475 });
      doc.moveTo(54, 760).lineTo(541, 760).strokeColor("#DCE5EF").stroke();
      doc.fillColor("#64748B").fontSize(8).text(`${company.name} · ${company.address}`, 54, 770, { width: 487, align: "center" });
      doc.text(`${company.website} · +91 ${company.phone}`, 54, 783, { width: 487, align: "center" });
      doc.end();
    } catch (error) { reject(error); }
  });
}

export async function getOrCreateCourseReceipt({ enrollment, payment, details, generate = generateCourseReceipt }) {
  const existing = await CourseReceipt.findOne({ enrollmentId: enrollment._id }).lean();
  if (existing) {
    try { return { record: existing, buffer: await readReceipt(existing.filename) }; }
    catch { throw new Error("The stored receipt file is unavailable."); }
  }
  const buffer = await generate(details);
  await fs.mkdir(RECEIPT_ROOT, { recursive: true });
  const filename = `${crypto.randomUUID()}.pdf`;
  const absolutePath = path.join(RECEIPT_ROOT, filename);
  await fs.writeFile(absolutePath, buffer, { flag: "wx", mode: 0o600 });
  const record = {
    enrollmentId: enrollment._id, paymentId: payment._id,
    receiptNumber: `PJ-RCP-${enrollment.reference}`, filename,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    amountMinor: payment.amountMinor, currency: payment.currency, generatedAt: new Date(),
  };
  try {
    const saved = await CourseReceipt.create(record);
    return { record: saved.toObject(), buffer };
  } catch (error) {
    await fs.unlink(absolutePath).catch(() => {});
    if (error.code !== 11000) throw error;
    const raced = await CourseReceipt.findOne({ enrollmentId: enrollment._id }).lean();
    if (!raced) throw error;
    return { record: raced, buffer: await readReceipt(raced.filename) };
  }
}

export async function readCourseReceiptFile(filename) {
  return readReceipt(filename);
}
