import nodemailer from "nodemailer";
import { getAdminSiteOrigin, getPublicApiOrigin, getPublicSiteOrigin } from "../../config/siteOrigins.js";

const BRAND = "#0A347F";
const ACCENT = "#08B8D0";

let transporter;
let testTransporter;

export function setEmailTransportForTests(value) {
  if (process.env.NODE_ENV !== "test") throw new Error("Email transport override is only available in test mode.");
  const previous = testTransporter;
  testTransporter = value;
  return () => { testTransporter = previous; };
}

function getTransporter() {
  if (testTransporter) return testTransporter;
  if (transporter) return transporter;

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    throw new Error("GMAIL_USER and GMAIL_APP_PASSWORD are not configured.");
  }

  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass: pass.replace(/\s/g, "") },
  });

  return transporter;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function displayValue(value) {
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join(", ");
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, child]) => `${key}: ${displayValue(child)}`)
      .filter((item) => !item.endsWith(": "))
      .join("; ");
  }
  return String(value ?? "").trim();
}

function readableLabel(key) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getCategory(enquiryType, isJobApplication) {
  if (isJobApplication) return "Career Application";
  return readableLabel(enquiryType || "Enquiry");
}

function renderAnswerRows(answers = {}) {
  return Object.entries(answers)
    .filter(([key, value]) => !/password|secret|token|resume|attachment/i.test(key) && displayValue(value))
    .map(([key, value]) => ({ label: readableLabel(key), value: displayValue(value) }));
}

function renderSummaryHtml(rows) {
  return rows.map(({ label, value }) => `
    <tr>
      <th align="left" valign="top" style="padding:10px 12px;border-bottom:1px solid #e8eef5;color:#64748b;font-size:13px;font-weight:600;">${escapeHtml(label)}</th>
      <td valign="top" style="padding:10px 12px;border-bottom:1px solid #e8eef5;color:#202938;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;">${escapeHtml(value)}</td>
    </tr>`).join("");
}

function createEmailHtml({ eyebrow, title, greeting, paragraphs, referenceNumber, rows, customer }) {
  const publicSite = getPublicSiteOrigin();
  const detailBlock = customer ? "" : `
    <h2 style="margin:28px 0 8px;color:${BRAND};font-size:16px;">Submission summary</h2>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">${renderSummaryHtml(rows)}</table>`;

  return `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f2f6fb;font-family:Arial,Helvetica,sans-serif;color:#202938;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(title)} · ${escapeHtml(referenceNumber)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;border:1px solid #e1e8f0;border-radius:14px;background:#ffffff;overflow:hidden;">
        <tr><td style="padding:24px 30px;background:${BRAND};border-bottom:5px solid ${ACCENT};">
          <div style="color:#bfeef4;font-size:11px;font-weight:700;letter-spacing:2px;">${escapeHtml(eyebrow)}</div>
          <div style="margin-top:8px;color:#ffffff;font-size:23px;font-weight:700;">ProJenius</div>
          <div style="margin-top:4px;color:#e2eaf5;font-size:13px;">Innovation Technology Private Limited</div>
        </td></tr>
        <tr><td style="padding:30px;">
          <h1 style="margin:0 0 18px;color:${BRAND};font-size:22px;line-height:1.35;">${escapeHtml(title)}</h1>
          <p style="margin:0 0 14px;font-size:15px;line-height:1.7;">${escapeHtml(greeting)}</p>
          ${paragraphs.map((paragraph) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.7;">${escapeHtml(paragraph)}</p>`).join("")}
          <div style="margin:22px 0;padding:16px 18px;border:1px solid #d9e8f2;border-left:4px solid ${ACCENT};border-radius:8px;background:#f7fbfd;">
            <div style="color:#64748b;font-size:12px;font-weight:700;letter-spacing:.7px;">REFERENCE NUMBER</div>
            <div style="margin-top:6px;color:${BRAND};font-size:19px;font-weight:700;letter-spacing:.5px;">${escapeHtml(referenceNumber)}</div>
          </div>
          ${detailBlock}
          <p style="margin:24px 0 0;color:#64748b;font-size:13px;line-height:1.7;">${customer ? "Your submission receipt is attached as a PDF. Please keep this reference number for future communication." : "The saved record and attached PDF receipt are available to the authorized admin team."}</p>
          <p style="margin:20px 0 0;font-size:14px;line-height:1.7;">Regards,<br><strong>ProJenius Team</strong><br><a href="${escapeHtml(publicSite)}" style="color:${BRAND};text-decoration:none;">Visit ProJenius</a></p>
        </td></tr>
        <tr><td style="padding:16px 30px;border-top:1px solid #e8eef5;color:#64748b;font-size:11px;line-height:1.6;">ProJenius Innovation Technology Private Limited<br>Madurai, Tamil Nadu</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
}

function getSafeError(error) {
  return error?.code
    ? `Email delivery failed (${String(error.code).slice(0, 40)}).`
    : "Email delivery failed.";
}

export function createSubmissionEmailMessages({
  customerEmail,
  customerName,
  referenceNumber,
  enquiryType,
  answers = {},
  createdAt,
  pdfBuffer,
  isJobApplication = false,
  adminEmail,
  fromEmail = process.env.GMAIL_USER || "notifications@projenius.in",
}) {
  const category = getCategory(enquiryType, isJobApplication);
  const rows = renderAnswerRows(answers);
  const dateLabel = createdAt
    ? new Date(createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })
    : "Not available";
  const attachments = [{
    filename: `ProJenius-${referenceNumber}.pdf`,
    content: pdfBuffer,
    contentType: "application/pdf",
  }];

  const customerMessage = {
    from: `"ProJenius" <${fromEmail}>`,
    to: customerEmail,
    replyTo: adminEmail,
    subject: `ProJenius submission received — ${referenceNumber}`,
    text: [
      `Hello ${customerName || "there"},`,
      "",
      "Your enquiry has been submitted successfully. Our team will contact you soon.",
      `Category: ${category}`,
      `Reference number: ${referenceNumber}`,
      "Your submission receipt is attached as a PDF.",
      `Regards, ProJenius Team — ${getPublicSiteOrigin()}`,
    ].join("\n"),
    html: createEmailHtml({
      eyebrow: "SUBMISSION CONFIRMATION",
      title: "We have received your submission",
      greeting: `Hello ${customerName || "there"},`,
      paragraphs: [
        "Your enquiry has been submitted successfully. Our team will contact you soon.",
        `We have recorded your ${category.toLowerCase()} submission.`,
      ],
      referenceNumber,
      rows,
      customer: true,
    }),
    attachments,
  };

  const adminMessage = {
    from: `"ProJenius" <${fromEmail}>`,
    to: adminEmail,
    replyTo: customerEmail,
    subject: `New ${category} submission — ${referenceNumber}`,
    text: [
      "A new submission has been saved in the ProJenius system.",
      `Category: ${category}`,
      `Reference number: ${referenceNumber}`,
      `Submitted: ${dateLabel}`,
      ...rows.map(({ label, value }) => `${label}: ${value}`),
      "The PDF receipt is attached. Review the complete record in the admin dashboard.",
    ].join("\n\n"),
    html: createEmailHtml({
      eyebrow: "ADMINISTRATOR NOTIFICATION",
      title: "A new submission has been saved",
      greeting: "A new submission is ready for review in the admin dashboard.",
      paragraphs: [`Category: ${category}`, `Submitted: ${dateLabel}`],
      referenceNumber,
      rows,
      customer: false,
    }),
    attachments,
  };

  return { customerMessage, adminMessage };
}

export async function verifyEmailTransport() {
  await getTransporter().verify();
}

export async function sendSubmissionEmails(details, channels = { customer: true, admin: true }) {
  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL?.trim();
  let mailer;
  try {
    mailer = getTransporter();
  } catch (error) {
    const message = getSafeError(error);
    return {
      customer: { status: "failed", error: message },
      admin: { status: "failed", error: message },
    };
  }

  const { customerMessage, adminMessage } = createSubmissionEmailMessages({
    ...details,
    adminEmail,
  });
  const skipped = Promise.resolve({ skipped: true });
  const [customerResult, adminResult] = await Promise.allSettled([
    channels.customer === false ? skipped : mailer.sendMail(customerMessage),
    channels.admin === false ? skipped : adminEmail
      ? mailer.sendMail(adminMessage)
      : Promise.reject(new Error("ADMIN_NOTIFICATION_EMAIL is not configured.")),
  ]);

  return {
    customer: customerResult.status === "fulfilled"
      ? { status: "sent", messageId: customerResult.value.messageId }
      : { status: "failed", error: getSafeError(customerResult.reason) },
    admin: adminResult.status === "fulfilled"
      ? { status: "sent", messageId: adminResult.value.messageId }
      : { status: "failed", error: getSafeError(adminResult.reason) },
  };
}

const DEFAULT_ADMIN_PANEL_URL = `${getAdminSiteOrigin()}/`;

function adminPanelUrl() {
  const configured = (process.env.ADMIN_PANEL_URL || "").trim();
  try { return new URL(configured || DEFAULT_ADMIN_PANEL_URL).href; } catch { return DEFAULT_ADMIN_PANEL_URL; }
}

function paidOn(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })
    : "";
}

/* Branded payment email: navy header, details table, optional button. */
function paymentEmailHtml({ eyebrow, title, intro, rows, receiptAttached, button, footer }) {
  const table = rows.filter(([, value]) => value).map(([label, value]) =>
    `<tr><td style="padding:11px 14px;border-bottom:1px solid #e8eef5;color:#5b6b80;font-size:14px">${escapeHtml(label)}</td><td style="padding:11px 14px;border-bottom:1px solid #e8eef5;font-weight:bold;font-size:14px;text-align:right">${escapeHtml(value)}</td></tr>`).join("");
  return `<!doctype html><html><body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f2f6fb;color:#0b1a2e;padding:24px 12px">
<main style="max-width:600px;margin:auto;background:#ffffff;border:1px solid #dce5ef;border-radius:14px;overflow:hidden">
<div style="background:#071426;padding:22px 28px"><p style="margin:0;color:#20c8f5;font-size:12px;font-weight:bold;letter-spacing:2px">${escapeHtml(eyebrow)}</p><h1 style="margin:8px 0 0;color:#ffffff;font-size:22px;line-height:1.3">${escapeHtml(title)}</h1></div>
<div style="padding:24px 28px">
${intro.map((line) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6">${escapeHtml(line)}</p>`).join("")}
<table role="presentation" style="width:100%;border-collapse:collapse;margin:8px 0 16px;background:#f7f9fc;border-radius:10px">${table}</table>
<p style="margin:0 0 16px;font-size:14px;color:#334155">${receiptAttached ? "&#128206; The payment receipt (PDF) is attached to this email." : "The PDF receipt could not be attached this time; it can be downloaded later from the receipt link."}</p>
${button ? `<p style="margin:0 0 18px"><a href="${escapeHtml(button.href)}" style="display:inline-block;background:#20c8f5;color:#071426;text-decoration:none;font-weight:bold;padding:13px 22px;border-radius:10px">${escapeHtml(button.label)}</a></p>` : ""}
${footer.map((line) => `<p style="margin:0 0 6px;font-size:13px;color:#5b6b80">${line}</p>`).join("")}
</div></main></body></html>`;
}

export async function sendCourseNotificationEmails(details, channels = { customer: true, admin: true }) {
  const configuredSender = process.env.GMAIL_USER?.trim();
  const adminRecipient = process.env.ADMIN_NOTIFICATION_EMAIL?.trim();
  const statuses = {};
  if (!channels.customer && !channels.admin) return statuses;
  if (!configuredSender || !process.env.GMAIL_APP_PASSWORD) {
    if (channels.customer) statuses.customer = { status: "not_configured" };
    if (channels.admin) statuses.admin = { status: "not_configured" };
    return statuses;
  }
  let mailer;
  try { mailer = getTransporter(); } catch {
    if (channels.customer) statuses.customer = { status: "not_configured" };
    if (channels.admin) statuses.admin = { status: "not_configured" };
    return statuses;
  }
  const attachment = details.pdfBuffer ? [{ filename: `ProJenius-Receipt-${details.reference}.pdf`, content: details.pdfBuffer, contentType: "application/pdf" }] : [];
  const amountText = `₹${(details.amountMinor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const paidAt = paidOn(details.paidAt);
  const firstName = String(details.student.name || "").trim().split(/\s+/)[0] || "there";
  const classMode = { online: "Online", offline: "Offline" }[details.student.preferredMode] || "";

  if (channels.customer) {
    const customerMessage = {
      from: `"ProJenius" <${configuredSender}>`, to: details.student.email,
      subject: `Thank you for enrolling in ${details.courseTitle} — ProJenius`,
      text: [
        `Hi ${firstName},`,
        "",
        `Thank you for enrolling in ${details.courseTitle} with ProJenius. We have received your payment.`,
        "",
        `Course: ${details.courseTitle}`,
        `Amount paid: ${amountText}`,
        classMode && `Class mode: ${classMode}`,
        `Reference: ${details.reference}`,
        `Payment ID: ${details.paymentId}`,
        paidAt && `Paid on: ${paidAt}`,
        "",
        details.pdfBuffer ? "Your payment receipt is attached as a PDF." : "",
        "What happens next: our team will call you with your batch details and the next steps.",
        "",
        "Need help? Call +91 89254 50473 or reply to this email with your reference.",
        "Team ProJenius",
      ].filter((line) => line !== false && line !== undefined).join("\n"),
      html: paymentEmailHtml({
        eyebrow: "PROJENIUS · ENROLMENT",
        title: `Thank you for enrolling, ${firstName}!`,
        intro: [`We have received your payment for ${details.courseTitle}.`, "Our team will call you with your batch details and the next steps."],
        rows: [["Course", details.courseTitle], ["Class mode", classMode], ["Amount paid", amountText], ["Reference", details.reference], ["Payment ID", details.paymentId], ["Paid on", paidAt]],
        receiptAttached: Boolean(details.pdfBuffer),
        footer: ["Need help? Call <a href=\"tel:+918925450473\" style=\"color:#0478a8\">+91 89254 50473</a> or reply to this email with your reference.", `Team ProJenius · <a href="${escapeHtml(getPublicSiteOrigin())}" style="color:#0478a8">Visit ProJenius</a>`],
      }),
      attachments: attachment,
    };
    statuses.customer = await mailer.sendMail(customerMessage).then((result) => ({ status: "sent", messageId: result.messageId })).catch((error) => ({ status: "failed", error: getSafeError(error) }));
  }

  if (channels.admin && adminRecipient) {
    const panel = adminPanelUrl();
    const adminMessage = {
      from: `"ProJenius" <${configuredSender}>`, to: adminRecipient, replyTo: details.student.email,
      subject: `New enrolment: ${details.student.name} — ${details.courseTitle} (${amountText})`,
      text: [
        "A customer has enrolled and paid.",
        "",
        `Student: ${details.student.name}`,
        `Email: ${details.student.email}`,
        `Phone: ${details.student.phone}`,
        `Course: ${details.courseTitle}`,
        classMode && `Class mode: ${classMode}`,
        `Amount paid: ${amountText}`,
        `Reference: ${details.reference}`,
        `Payment ID: ${details.paymentId}`,
        paidAt && `Paid on: ${paidAt}`,
        "",
        "Please call the student to share the batch details.",
        `Admin login: ${panel}`,
      ].filter((line) => line !== false && line !== undefined).join("\n"),
      html: paymentEmailHtml({
        eyebrow: "PROJENIUS ADMIN · NEW ENROLMENT",
        title: `${details.student.name} enrolled in ${details.courseTitle}`,
        intro: ["A customer has enrolled and paid. Please call the student to share the batch details."],
        rows: [["Student", details.student.name], ["Email", details.student.email], ["Phone", details.student.phone], ["Course", details.courseTitle], ["Class mode", classMode], ["Amount paid", amountText], ["Reference", details.reference], ["Payment ID", details.paymentId], ["Paid on", paidAt]],
        receiptAttached: Boolean(details.pdfBuffer),
        button: { label: "Open admin panel", href: panel },
        footer: [`Or copy this link: ${escapeHtml(panel)}`, "Reply to this email to write to the student directly."],
      }),
      attachments: attachment,
    };
    statuses.admin = await mailer.sendMail(adminMessage).then((result) => ({ status: "sent", messageId: result.messageId })).catch((error) => ({ status: "failed", error: getSafeError(error) }));
  } else if (channels.admin) {
    statuses.admin = { status: "not_configured" };
  }
  return statuses;
}

export async function sendCourseScheduleEmail({ enrollment, course, cancelled = false, change = {} }) {
  const sender = process.env.GMAIL_USER?.trim();
  const password = process.env.GMAIL_APP_PASSWORD;
  if (!sender || !password) return { status: "not_configured" };
  let mailer;
  try { mailer = getTransporter(); } catch { return { status: "not_configured" }; }
  const batch = (course.batches || []).find((item) => String(item._id) === String(enrollment.batchId));
  const sessions = (batch?.sessions || []).filter((session) => session.status !== "cancelled");
  const schedule = sessions.map((session) => `${session.title}: ${new Date(session.startsAt).toLocaleString("en-IN", { timeZone: batch.timezone || "Asia/Kolkata" })} (${batch.timezone || "Asia/Kolkata"})`).join("\n");
  const title = cancelled ? "Programme schedule update" : "Your programme schedule has changed";
  const reason = String(change.reason || "").slice(0, 500);
  const text = `Hello ${enrollment.student.name},\n\n${cancelled ? `The programme ${course.title} has been cancelled.` : `The schedule for ${course.title} has changed.`}\nRegistration reference: ${enrollment.reference}\n${batch ? `Batch: ${batch.label}\n` : ""}${schedule ? `Updated sessions:\n${schedule}\n` : ""}${reason ? `Update: ${reason}\n` : ""}Any payment or refund decision is handled separately under the published policy and applicable law. Please contact ProJenius through ${getPublicSiteOrigin()} for support.`;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f2f6fb;color:#202938;padding:24px"><main style="max-width:620px;margin:auto;background:#fff;border:1px solid #dce5ef;border-radius:12px;padding:28px"><p style="color:#08b8d0;font-weight:bold">PROJENIUS LIVE TRAINING</p><h1 style="color:#0a347f;font-size:22px">${escapeHtml(title)}</h1><p>Hello ${escapeHtml(enrollment.student.name)},</p><p>${cancelled ? `The programme ${escapeHtml(course.title)} has been cancelled.` : `The schedule for ${escapeHtml(course.title)} has changed.`}</p>${batch ? `<p>Batch: ${escapeHtml(batch.label)}</p>` : ""}<ul>${sessions.map((session) => `<li>${escapeHtml(session.title)}: ${escapeHtml(new Date(session.startsAt).toLocaleString("en-IN", { timeZone: batch.timezone || "Asia/Kolkata" }))} (${escapeHtml(batch.timezone || "Asia/Kolkata")})</li>`).join("")}</ul>${reason ? `<p>${escapeHtml(reason)}</p>` : ""}<p>Payment or refund decisions are handled separately under the published policy and applicable law.</p><p>Reference: <strong>${escapeHtml(enrollment.reference)}</strong></p><p>Contact ProJenius through ${getPublicSiteOrigin()} for support.</p></main></body></html>`;
  try {
    await mailer.sendMail({ from: `"ProJenius" <${sender}>`, to: enrollment.student.email, subject: `${title} · ${enrollment.reference}`, text, html });
    return { status: "sent" };
  } catch (error) { return { status: "failed", error: getSafeError(error) }; }
}

export async function sendCourseReceiptLinkEmail({ enrollment, course, payment, pdfBuffer, url }) {
  const sender = process.env.GMAIL_USER?.trim();
  const password = process.env.GMAIL_APP_PASSWORD;
  if (!sender || !password || !url) return { status: "not_configured" };
  let mailer;
  try { mailer = getTransporter(); } catch { return { status: "not_configured" }; }
  const amountText = `INR ${(payment.amountMinor / 100).toFixed(2)}`;
  const text = `Hello ${enrollment.student.name},\n\nYour verified payment receipt for ${course.title} is available through this secure link, which expires in seven days: ${url}\nReference: ${enrollment.reference}. Amount: ${amountText}.\nIf the link expires, request a new one from the course confirmation page using your registration reference and registered email address.`;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f2f6fb;color:#202938;padding:24px"><main style="max-width:620px;margin:auto;background:#fff;border:1px solid #dce5ef;border-radius:12px;padding:28px"><p style="color:#08b8d0;font-weight:bold">PROJENIUS LIVE TRAINING</p><h1 style="color:#0a347f;font-size:22px">Your secure payment receipt</h1><p>Hello ${escapeHtml(enrollment.student.name)},</p><p>Your captured payment for ${escapeHtml(course.title)} (${escapeHtml(amountText)}) was verified.</p><p><a href="${escapeHtml(url)}">Download your receipt</a>. This private link expires in seven days.</p><p>Registration reference: <strong>${escapeHtml(enrollment.reference)}</strong></p><p>Questions? Contact ProJenius through <a href="${escapeHtml(getPublicSiteOrigin())}">our website</a>.</p></main></body></html>`;
  try {
    await mailer.sendMail({ from: `"ProJenius" <${sender}>`, to: enrollment.student.email, subject: `Secure course receipt · ${enrollment.reference}`, text, html, attachments: [{ filename: `ProJenius-Course-${enrollment.reference}.pdf`, content: pdfBuffer, contentType: "application/pdf" }] });
    return { status: "sent" };
  } catch (error) { return { status: "failed", error: getSafeError(error) }; }
}


function publicOrigin() {
  return getPublicSiteOrigin();
}

function newsletterShell(title, body) {
  return `<!doctype html><html><body style="margin:0;background:#f2f6fb;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#202938"><main style="max-width:620px;margin:auto;background:#fff;border:1px solid #dce5ef;border-radius:12px;overflow:hidden"><header style="padding:22px 28px;background:#0a347f;color:white;border-bottom:4px solid #08b8d0"><strong style="font-size:20px">ProJenius</strong><div style="font-size:12px;margin-top:4px">Innovation Technology Private Limited</div></header><section style="padding:28px"><h1 style="margin:0 0 18px;color:#0a347f;font-size:23px">${escapeHtml(title)}</h1>${body}</section></main></body></html>`;
}

export async function sendNewsletterConfirmationEmail({ email, token }) {
  const sender = process.env.GMAIL_USER?.trim();
  if (!sender || !process.env.GMAIL_APP_PASSWORD) return { status: "not_configured" };
  const origin = publicOrigin();
  if (!origin || !token) return { status: "not_configured" };
  let mailer; try { mailer = getTransporter(); } catch { return { status: "not_configured" }; }
  const url = `${origin}/newsletter/confirm?token=${encodeURIComponent(token)}`;
  const text = `Confirm your ProJenius newsletter subscription by visiting: ${url}\nThis link expires in 24 hours. If you did not request this, ignore this message.`;
  const html = newsletterShell("Confirm your newsletter subscription", `<p>Click below to confirm that you want ProJenius news and updates by email.</p><p><a href="${escapeHtml(url)}" style="display:inline-block;background:#0a347f;color:white;padding:12px 18px;border-radius:6px;text-decoration:none">Confirm subscription</a></p><p>This link expires in 24 hours. If you did not request this, ignore this message.</p>`);
  try { const result = await mailer.sendMail({ from: `"ProJenius" <${sender}>`, to: email, subject: "Confirm your ProJenius newsletter subscription", text, html }); return { status: "sent", messageId: result.messageId }; }
  catch (error) { return { status: "failed", error: getSafeError(error) }; }
}

export async function sendNewsletterWelcomeEmail({ email, websiteUrl, newsInsightsUrl, unsubscribeUrl, listUnsubscribeUrl = "" }) {
  const sender = process.env.GMAIL_USER?.trim();
  if (!sender || !process.env.GMAIL_APP_PASSWORD) return { status: "not_configured" };
  const origin = publicOrigin();
  if (!origin) return { status: "not_configured" };
  const allowedUrl = (value) => {
    try {
      const url = new URL(value);
      return url.origin === origin && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ? url.href : null;
    } catch { return null; }
  };
  const website = allowedUrl(websiteUrl);
  const news = allowedUrl(newsInsightsUrl);
  const unsubscribe = allowedUrl(unsubscribeUrl);
  if (!website || !news || !unsubscribe) return { status: "failed", error: "Welcome email links are not on the configured public site." };
  let safeListUnsubscribe = "";
  if (listUnsubscribeUrl) {
    try {
      const url = new URL(listUnsubscribeUrl);
      const configuredApi = new URL(getPublicApiOrigin());
      const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
      if ((url.origin === origin || url.origin === configuredApi.origin) && (url.protocol === "https:" || localHttp)) safeListUnsubscribe = url.href;
    } catch { /* Optional one-click unsubscribe header is omitted. */ }
  }
  let mailer;
  try { mailer = getTransporter(); } catch { return { status: "not_configured" }; }
  const text = [
    "Thank you for subscribing to ProJenius Innovation Technology Private Limited.",
    "You're now subscribed to our email updates! We'll keep you informed about our latest company news, technology insights, innovations, achievements, projects, and announcements.",
    "Our latest updates will be shared with you through email as new content becomes available.",
    `Visit ProJenius: ${website}`,
    `Explore News & Insights: ${news}`,
    "Thank you for being part of our community.",
    "Regards,\nTeam ProJenius\nProJenius Innovation Technology Private Limited",
    `Unsubscribe: ${unsubscribe}`,
  ].join("\n\n");
  const html = newsletterShell("Welcome to ProJenius News & Insights!", `<p>Thank you for subscribing to ProJenius Innovation Technology Private Limited.</p><p>You're now subscribed to our email updates! We'll keep you informed about our latest company news, technology insights, innovations, achievements, projects, and announcements.</p><p>Our latest updates will be shared with you through email as new content becomes available.</p><p><a href="${escapeHtml(website)}">Visit ProJenius</a></p><p><a href="${escapeHtml(news)}">Explore News &amp; Insights</a></p><p>Thank you for being part of our community.</p><p>Regards,<br>Team ProJenius<br>ProJenius Innovation Technology Private Limited</p><p style="margin-top:28px;color:#64748b;font-size:12px"><a href="${escapeHtml(unsubscribe)}">Unsubscribe</a></p>`);
  const headers = safeListUnsubscribe ? { "List-Unsubscribe": `<${safeListUnsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {};
  try {
    const result = await mailer.sendMail({ from: `"ProJenius" <${sender}>`, to: email, subject: "Welcome to ProJenius News & Insights!", text, html, headers });
    return { status: "sent", messageId: result.messageId };
  } catch (error) { return { status: "failed", error: getSafeError(error) }; }
}

export async function sendNewsletterAnnouncementEmail({ email, content, unsubscribeUrl, listUnsubscribeUrl = unsubscribeUrl }) {
  const sender = process.env.GMAIL_USER?.trim();
  if (!sender || !process.env.GMAIL_APP_PASSWORD) return { status: "not_configured" };
  const origin = publicOrigin();
  if (!origin || !unsubscribeUrl) return { status: "not_configured" };
  const allowedOrigin = (value) => { try { const url = new URL(value); const localDevelopmentUrl = process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase()); return (url.origin === origin || url.origin === new URL(getPublicApiOrigin()).origin) && (url.protocol === "https:" || localDevelopmentUrl); } catch { return false; } };
  if (!allowedOrigin(unsubscribeUrl) || (listUnsubscribeUrl && !allowedOrigin(listUnsubscribeUrl))) return { status: "failed", error: "Unsubscribe URL is not on a configured public origin." };
  let safeUrl; let safeImage = "";
  try { safeUrl = new URL(content.url); if (safeUrl.origin !== origin) return { status: "failed", error: "Announcement URL is not on the configured public site." }; }
  catch { return { status: "failed", error: "Announcement URL is invalid." }; }
  if (content.image) { try { const imageUrl = new URL(content.image); const configuredApi = new URL(getPublicApiOrigin()); const allowedImageOrigins = new Set([origin, configuredApi.origin]); const localHost = ["localhost", "127.0.0.1", "::1"].includes(imageUrl.hostname.toLowerCase()); const safeProtocol = imageUrl.protocol === "https:" || (process.env.NODE_ENV !== "production" && imageUrl.protocol === "http:" && localHost); if (allowedImageOrigins.has(imageUrl.origin) && safeProtocol && !imageUrl.username && !imageUrl.password && !imageUrl.search && !imageUrl.hash) safeImage = `<img src="${escapeHtml(imageUrl.href)}" alt="${escapeHtml(content.imageAlt || "")}" width="100%" style="display:block;width:100%;max-width:100%;height:auto;border:0;border-radius:8px;margin:0 0 18px">`; } catch { /* optional image is omitted */ } }
  let mailer; try { mailer = getTransporter(); } catch { return { status: "not_configured" }; }
  const title = String(content.title || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180) || (content.type === "course" ? "a new ProJenius course" : "ProJenius update");
  const summary = String(content.summary || "").trim().slice(0, 500);
  const category = String(content.category || "").replace(/\s+/g, " ").trim().slice(0, 100);
  const categoryText = category ? `Category: ${category}\n\n` : "";
  const categoryHtml = category ? `<p style="margin:0 0 12px;color:#64748b;font-size:13px">${escapeHtml(category)}</p>` : "";
  const isCourse = content.type === "course";
  const validMinorAmount = (amount) => Number.isSafeInteger(amount) && amount >= 0;
  const formatMoney = (amount) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount / 100);
  const hasPrice = validMinorAmount(content.priceMinor);
  const hasListPrice = validMinorAmount(content.listPriceMinor) && hasPrice && content.listPriceMinor > content.priceMinor;
  const discountPercent = hasListPrice ? Math.round((1 - content.priceMinor / content.listPriceMinor) * 100) : 0;
  const courseMetaText = isCourse ? [content.duration, content.deliveryMode].filter((value) => typeof value === "string" && value.trim()).join(" · ") : "";
  const coursePriceText = hasPrice ? `Price: ${formatMoney(content.priceMinor)}${hasListPrice ? ` (was ${formatMoney(content.listPriceMinor)}, ${discountPercent}% off)` : ""}\n\n` : "";
  const courseMetaHtml = courseMetaText ? `<p style="margin:0 0 12px;color:#64748b;font-size:13px">${escapeHtml(courseMetaText)}</p>` : "";
  const coursePriceHtml = hasPrice ? `<p style="margin:0 0 16px;color:#102846;font-size:19px;font-weight:bold">${formatMoney(content.priceMinor)}${hasListPrice ? ` <span style="padding-left:8px;color:#7a8797;font-size:14px;font-weight:normal;text-decoration:line-through">${formatMoney(content.listPriceMinor)}</span><span style="padding-left:8px;color:#167448;font-size:13px;font-weight:bold">${discountPercent}% off</span>` : ""}</p>` : "";
  const emailTitle = isCourse ? "A new course from ProJenius" : title;
  const marketingCopy = isCourse
    ? `Something new is here. Explore ${title}, review the course details, and see whether it fits your goals.`
    : summary;
  const courseCardHtml = isCourse
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin:20px 0;border:1px solid #dce5ef;border-radius:10px;border-collapse:separate"><tr><td style="padding:18px">${safeImage}${categoryHtml}<h2 style="margin:0 0 12px;color:#102846;font-size:20px;line-height:1.4">${escapeHtml(title)}</h2>${courseMetaHtml}<p style="margin:0 0 16px;color:#344258;font-size:15px;line-height:1.7">${escapeHtml(summary)}</p>${coursePriceHtml}<p style="margin:0"><a href="${escapeHtml(safeUrl.href)}" style="display:inline-block;background:#0a347f;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-size:15px;font-weight:bold">Explore This Course</a></p></td></tr></table>`
    : `${categoryHtml}${safeImage}<p style="font-size:15px;line-height:1.7">${escapeHtml(summary)}</p><p><a href="${escapeHtml(safeUrl.href)}" style="display:inline-block;background:#0a347f;color:white;padding:12px 18px;border-radius:6px;text-decoration:none">Read More</a></p>`;
  const text = `${isCourse ? `${marketingCopy}\n\n` : ""}${categoryText}${title}\n\n${summary}\n\n${courseMetaText ? `${courseMetaText}\n\n` : ""}${coursePriceText}${isCourse ? "Explore This Course" : "Read More"}: ${safeUrl.href}\n\nUnsubscribe: ${unsubscribeUrl}`;
  const html = newsletterShell(emailTitle, `<p style="margin:0 0 16px;color:#344258;font-size:15px;line-height:1.7">${escapeHtml(marketingCopy)}</p>${courseCardHtml}<p style="margin:20px 0 0;color:#64748b;font-size:12px;line-height:1.6"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#64748b;text-decoration:underline">Unsubscribe</a></p>`);
  const headers = listUnsubscribeUrl ? { "List-Unsubscribe": `<${listUnsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {};
  const subjectTitle = title.slice(0, 80).trim();
  const subject = isCourse ? `🚀 Ready to Level Up? Discover ${subjectTitle} at ProJenius` : `${content.type === "blog" ? "New blog" : "News & Insights"}: ${subjectTitle}`;
  try { const result = await mailer.sendMail({ from: `"ProJenius" <${sender}>`, to: email, subject, text, html, headers }); return { status: "sent", messageId: result.messageId }; }
  catch (error) { return { status: "failed", error: getSafeError(error) }; }
}

// SECTION: CAREER GUIDANCE CALL EMAILS
export async function sendGuidanceEmails({ booking, slot, receiptPdf, detailsPdf }, channels = { customer: true, admin: true }) {
  const sender = process.env.GMAIL_USER?.trim();
  const adminRecipient = process.env.ADMIN_NOTIFICATION_EMAIL?.trim();
  const statuses = {};
  if (!sender || !process.env.GMAIL_APP_PASSWORD) {
    if (channels.customer) statuses.customer = { status: "not_configured" };
    if (channels.admin) statuses.admin = { status: "not_configured" };
    return statuses;
  }
  let mailer;
  try { mailer = getTransporter(); } catch {
    if (channels.customer) statuses.customer = { status: "not_configured" };
    if (channels.admin) statuses.admin = { status: "not_configured" };
    return statuses;
  }
  const amount = `₹${(booking.amountMinor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const meet = booking.meetLink || "";
  const firstName = String(booking.student.name || "").trim().split(/\s+/)[0] || "there";
  const receiptAttachment = receiptPdf ? [{ filename: `ProJenius-Guidance-Receipt-${booking.reference}.pdf`, content: receiptPdf, contentType: "application/pdf" }] : [];

  if (channels.customer) {
    const rows = [["Call", `1:1 Career Guidance (${booking.callMinutes} min)`], ["Date & time", `${slot} (IST)`], ["Google Meet", meet || "The link will be shared before the call"], ["Preparing for", booking.targetRole], ["Amount paid", amount], ["Reference", booking.reference], ["Payment ID", booking.paymentId]];
    statuses.customer = await mailer.sendMail({
      from: `"ProJenius" <${sender}>`, to: booking.student.email,
      subject: `Your career guidance call is booked – ${slot}`,
      text: [`Hi ${firstName},`, "", "Your 1:1 career guidance call with ProJenius is confirmed.", "", ...rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`), "", meet ? `Join here at the time above: ${meet}` : "", "Your payment receipt is attached as a PDF.", "", "Need to change the time? Call +91 89254 50473 or reply to this email.", "Team ProJenius"].filter((line) => line !== "").join("\n"),
      html: paymentEmailHtml({
        eyebrow: "PROJENIUS · CAREER GUIDANCE",
        title: `Your call is booked, ${firstName}!`,
        intro: ["Your 1:1 career guidance call is confirmed. Join with the Google Meet link at the time below."],
        rows, receiptAttached: Boolean(receiptPdf),
        button: meet ? { label: "Join Google Meet", href: meet } : null,
        footer: ["Need to change the time? Call <a href=\"tel:+918925450473\" style=\"color:#0478a8\">+91 89254 50473</a> or reply to this email.", "Team ProJenius · <a href=\"https://projenius.in\" style=\"color:#0478a8\">projenius.in</a>"],
      }),
      attachments: receiptAttachment,
    }).then((r) => ({ status: "sent", messageId: r.messageId })).catch((error) => ({ status: "failed", error: getSafeError(error) }));
  }

  if (channels.admin) {
    if (!adminRecipient) statuses.admin = { status: "not_configured" };
    else {
      const panel = adminPanelUrl();
      const rows = [["Student", booking.student.name], ["Email", booking.student.email], ["Phone", booking.student.phone], ["Date & time", `${slot} (IST)`], ["Preparing for", booking.targetRole], ["Message", booking.notes || "—"], ["Amount paid", amount], ["Reference", booking.reference], ["Payment ID", booking.paymentId], ["Google Meet", meet || "Not set – add it in Admin › Career Guidance"]];
      statuses.admin = await mailer.sendMail({
        from: `"ProJenius" <${sender}>`, to: adminRecipient, replyTo: booking.student.email,
        subject: `New guidance call: ${booking.student.name} – ${slot} (${amount})`,
        text: ["A student has booked and paid for a 1:1 career guidance call.", "", ...rows.map(([k, v]) => `${k}: ${v}`), "", `Admin login: ${panel}`].join("\n"),
        html: paymentEmailHtml({
          eyebrow: "PROJENIUS ADMIN · CAREER GUIDANCE",
          title: `${booking.student.name} booked a guidance call`,
          intro: ["A student has booked and paid. The booking details PDF and the payment receipt are attached."],
          rows, receiptAttached: Boolean(receiptPdf),
          button: { label: "Open admin panel", href: panel },
          footer: [meet ? `Google Meet: <a href="${escapeHtml(meet)}" style="color:#0478a8">${escapeHtml(meet)}</a>` : "Add the Google Meet link in Admin › Career Guidance.", "Reply to this email to write to the student directly."],
        }),
        attachments: [...(detailsPdf ? [{ filename: `ProJenius-Guidance-Booking-${booking.reference}.pdf`, content: detailsPdf, contentType: "application/pdf" }] : []), ...receiptAttachment],
      }).then((r) => ({ status: "sent", messageId: r.messageId })).catch((error) => ({ status: "failed", error: getSafeError(error) }));
    }
  }
  return statuses;
}
