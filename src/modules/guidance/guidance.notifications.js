/* =========================================================
   PROJENIUS BACKEND — CAREER GUIDANCE RECEIPT + EMAILS
   Student: Meet link, date & time, details, receipt PDF.
   Admin: student details and message, booking PDF, receipt
   PDF, admin panel link and the Meet link.
========================================================= */

import PDFDocument from "pdfkit";
import { generateSubmissionPdf } from "../../shared/pdf/index.js";
import { sendGuidanceEmails } from "../../shared/email/email.service.js";
import { GuidanceBooking } from "./guidance.models.js";

const COMPANY = {
  name: "ProJenius Innovation Technology Private Limited",
  address: "Plot No 3, Erikarai Street, Velmurugan Nagar, Namachivaya Nagar, Madurai, Tamil Nadu 625003",
  phone: "+91 89254 50473",
};

let testRuntime;
export function setGuidanceRuntimeForTests(runtime) {
  if (process.env.NODE_ENV !== "test") throw new Error("Test runtime is only available in test mode.");
  const previous = testRuntime;
  testRuntime = runtime;
  return () => { testRuntime = previous; };
}

export const slotText = (booking) => new Date(booking.slotStart).toLocaleString("en-IN", {
  weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
});
export const rupees = (minor) => `INR ${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

export function generateGuidanceReceipt(booking) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 54, info: { Title: `ProJenius Career Guidance Receipt ${booking.reference}`, Author: COMPANY.name } });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("error", reject);
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.fillColor("#0A347F").fontSize(22).font("Helvetica-Bold").text("ProJenius");
      doc.fillColor("#64748B").fontSize(9).font("Helvetica").text(COMPANY.name);
      doc.moveDown(2);
      doc.fillColor("#0A347F").fontSize(19).font("Helvetica-Bold").text("CAREER GUIDANCE PAYMENT RECEIPT");
      doc.moveDown(1.4);
      const rows = [
        ["Booking reference", booking.reference], ["Payment status", "PAID · VERIFIED"],
        ["Student", booking.student.name], ["Student email", booking.student.email], ["Phone", booking.student.phone],
        ["Service", `1:1 Career Guidance Call (${booking.callMinutes} minutes)`],
        ["Call date & time", `${slotText(booking)} (IST)`],
        ["Paid on", new Date(booking.paidAt || Date.now()).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })],
        ["Amount paid", rupees(booking.amountMinor)],
        ["Payment reference", booking.paymentId],
      ];
      for (const [label, value] of rows) {
        doc.fillColor("#64748B").font("Helvetica-Bold").fontSize(9).text(label.toUpperCase());
        doc.fillColor("#202938").font("Helvetica").fontSize(12).text(String(value || "—"), { width: 475 });
        doc.moveDown(0.7);
      }
      doc.moveDown(0.8);
      doc.fillColor("#64748B").fontSize(9).text("This receipt confirms a payment verified by the ProJenius payment service.", { width: 475 });
      doc.moveTo(54, 760).lineTo(541, 760).strokeColor("#DCE5EF").stroke();
      doc.fillColor("#64748B").fontSize(8).text(`${COMPANY.name} · ${COMPANY.address}`, 54, 770, { width: 487, align: "center" });
      doc.text(`projenius.in · ${COMPANY.phone}`, 54, 783, { width: 487, align: "center" });
      doc.end();
    } catch (error) { reject(error); }
  });
}

function bookingDetailsPdf(booking) {
  return generateSubmissionPdf({
    referenceNumber: booking.reference,
    enquiryType: "career guidance call",
    sourcePage: "career-guidance",
    createdAt: booking.createdAt,
    isJobApplication: false,
    answers: {
      name: booking.student.name, email: booking.student.email, phone: booking.student.phone,
      preparingFor: booking.targetRole || "—", messageForMentor: booking.notes || "—",
      callDateTime: `${slotText(booking)} (IST)`, slotType: booking.slotType === "custom" ? "Convenient (custom) slot" : "Fixed slot",
      amountPaid: rupees(booking.amountMinor), paymentId: booking.paymentId,
    },
  });
}

/* Sends the failed or not-yet-sent emails for a confirmed booking. */
export async function sendBookingEmails(bookingId, { only } = {}) {
  const booking = await GuidanceBooking.findById(bookingId).lean();
  if (!booking || !["confirmed", "completed"].includes(booking.status)) return null;
  const channels = only || { customer: booking.customerEmailStatus !== "sent", admin: booking.adminEmailStatus !== "sent" };
  if (!channels.customer && !channels.admin) return booking;
  let receiptPdf, detailsPdf;
  try {
    receiptPdf = await (testRuntime?.generateReceipt || generateGuidanceReceipt)(booking);
    detailsPdf = await (testRuntime?.generateDetails || bookingDetailsPdf)(booking);
  } catch {
    await GuidanceBooking.updateOne({ _id: booking._id }, { $set: { emailError: "The receipt PDF could not be created." } });
  }
  const result = await (testRuntime?.sendEmails || sendGuidanceEmails)({ booking, slot: slotText(booking), receiptPdf, detailsPdf }, channels);
  const set = { emailError: "" };
  if (channels.customer) set.customerEmailStatus = result.customer?.status === "sent" ? "sent" : result.customer?.status === "not_configured" ? "not_configured" : "failed";
  if (channels.admin) set.adminEmailStatus = result.admin?.status === "sent" ? "sent" : result.admin?.status === "not_configured" ? "not_configured" : "failed";
  const errors = [result.customer?.error, result.admin?.error].filter(Boolean);
  if (errors.length) set.emailError = errors.join(" ").slice(0, 300);
  await GuidanceBooking.updateOne({ _id: booking._id }, { $set: set });
  return GuidanceBooking.findById(bookingId).lean();
}
