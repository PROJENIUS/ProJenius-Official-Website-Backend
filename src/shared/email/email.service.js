import nodemailer from "nodemailer";

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
          <p style="margin:20px 0 0;font-size:14px;line-height:1.7;">Regards,<br><strong>ProJenius Team</strong><br><a href="https://projenius.in" style="color:${BRAND};text-decoration:none;">projenius.in</a></p>
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
      "Regards, ProJenius Team — https://projenius.in",
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

export async function sendSubmissionEmails(details) {
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
  const [customerResult, adminResult] = await Promise.allSettled([
    mailer.sendMail(customerMessage),
    adminEmail
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

function courseEmailHtml({ title, greeting, reference, courseTitle, amountText, student, status, receiptAttached, followUpText = "" }) {
  const rows = [
    ["Course", courseTitle], ["Reference", reference], ["Amount", amountText], ["Payment status", status],
    ...(student ? [["Student", student.name], ["Email", student.email], ["Phone", student.phone]] : []),
  ];
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f2f6fb;color:#202938;padding:24px"><main style="max-width:620px;margin:auto;background:white;border:1px solid #dce5ef;border-radius:12px;padding:28px"><p style="color:#08b8d0;font-weight:bold">PROJENIUS COURSE ENROLMENT</p><h1 style="color:#0a347f;font-size:22px">${escapeHtml(title)}</h1><p>${escapeHtml(greeting)}</p><table style="width:100%;border-collapse:collapse">${rows.map(([label,value]) => `<tr><th align="left" style="padding:9px;border-bottom:1px solid #e8eef5;color:#64748b">${escapeHtml(label)}</th><td style="padding:9px;border-bottom:1px solid #e8eef5">${escapeHtml(value)}</td></tr>`).join("")}</table><p>${receiptAttached ? "Your verified payment receipt is attached." : "Your verified enrolment is recorded. A PDF receipt could not be generated for this message."}</p>${followUpText ? `<p>${escapeHtml(followUpText)}</p>` : ""}<p>Questions? Visit <a href="https://projenius.in">projenius.in</a>.</p></main></body></html>`;
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
  const attachment = details.pdfBuffer ? [{ filename: `ProJenius-Course-${details.reference}.pdf`, content: details.pdfBuffer, contentType: "application/pdf" }] : [];
  const amountText = `INR ${(details.amountMinor / 100).toFixed(2)}`;
  if (channels.customer) {
    const customerMessage = {
      from: `"ProJenius" <${configuredSender}>`, to: details.student.email,
      subject: `Payment received; approval pending — ${details.reference}`,
      text: `Your payment for ${details.courseTitle} was verified. Your registration is awaiting admin approval. ProJenius will contact you by phone to coordinate the next steps. Reference: ${details.reference}. Amount: ${amountText}.`,
      html: courseEmailHtml({ title: "Payment received; registration awaiting approval", greeting: `Hello ${details.student.name},`, ...details, amountText, status: "Captured — awaiting admin approval", receiptAttached: Boolean(details.pdfBuffer), followUpText: "ProJenius will contact you by phone to coordinate the next steps." }), attachments: attachment,
    };
    statuses.customer = await mailer.sendMail(customerMessage).then((result) => ({ status: "sent", messageId: result.messageId })).catch((error) => ({ status: "failed", error: getSafeError(error) }));
  }
  if (channels.admin && adminRecipient) {
    const adminMessage = {
      from: `"ProJenius" <${configuredSender}>`, to: adminRecipient, replyTo: details.student.email,
      subject: `Paid registration awaiting approval — ${details.reference}`,
      text: `A course payment was verified and its registration is awaiting admin approval. Please contact the student by phone to coordinate the next steps. Reference: ${details.reference}. Course: ${details.courseTitle}. Amount: ${amountText}.`,
      html: courseEmailHtml({ title: "A paid registration is awaiting approval", greeting: "A paid registration is ready for admin review. Please contact the student by phone to coordinate the next steps.", ...details, student: details.student, amountText, status: "Captured — awaiting admin approval", receiptAttached: Boolean(details.pdfBuffer) }), attachments: attachment,
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
  const text = `Hello ${enrollment.student.name},\n\n${cancelled ? `The programme ${course.title} has been cancelled.` : `The schedule for ${course.title} has changed.`}\nRegistration reference: ${enrollment.reference}\n${batch ? `Batch: ${batch.label}\n` : ""}${schedule ? `Updated sessions:\n${schedule}\n` : ""}${reason ? `Update: ${reason}\n` : ""}Any payment or refund decision is handled separately under the published policy and applicable law. Please contact ProJenius through projenius.in for support.`;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f2f6fb;color:#202938;padding:24px"><main style="max-width:620px;margin:auto;background:#fff;border:1px solid #dce5ef;border-radius:12px;padding:28px"><p style="color:#08b8d0;font-weight:bold">PROJENIUS LIVE TRAINING</p><h1 style="color:#0a347f;font-size:22px">${escapeHtml(title)}</h1><p>Hello ${escapeHtml(enrollment.student.name)},</p><p>${cancelled ? `The programme ${escapeHtml(course.title)} has been cancelled.` : `The schedule for ${escapeHtml(course.title)} has changed.`}</p>${batch ? `<p>Batch: ${escapeHtml(batch.label)}</p>` : ""}<ul>${sessions.map((session) => `<li>${escapeHtml(session.title)}: ${escapeHtml(new Date(session.startsAt).toLocaleString("en-IN", { timeZone: batch.timezone || "Asia/Kolkata" }))} (${escapeHtml(batch.timezone || "Asia/Kolkata")})</li>`).join("")}</ul>${reason ? `<p>${escapeHtml(reason)}</p>` : ""}<p>Payment or refund decisions are handled separately under the published policy and applicable law.</p><p>Reference: <strong>${escapeHtml(enrollment.reference)}</strong></p><p>Contact ProJenius through projenius.in for support.</p></main></body></html>`;
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
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f2f6fb;color:#202938;padding:24px"><main style="max-width:620px;margin:auto;background:#fff;border:1px solid #dce5ef;border-radius:12px;padding:28px"><p style="color:#08b8d0;font-weight:bold">PROJENIUS LIVE TRAINING</p><h1 style="color:#0a347f;font-size:22px">Your secure payment receipt</h1><p>Hello ${escapeHtml(enrollment.student.name)},</p><p>Your captured payment for ${escapeHtml(course.title)} (${escapeHtml(amountText)}) was verified.</p><p><a href="${escapeHtml(url)}">Download your receipt</a>. This private link expires in seven days.</p><p>Registration reference: <strong>${escapeHtml(enrollment.reference)}</strong></p><p>Questions? Contact ProJenius through projenius.in.</p></main></body></html>`;
  try {
    await mailer.sendMail({ from: `"ProJenius" <${sender}>`, to: enrollment.student.email, subject: `Secure course receipt · ${enrollment.reference}`, text, html, attachments: [{ filename: `ProJenius-Course-${enrollment.reference}.pdf`, content: pdfBuffer, contentType: "application/pdf" }] });
    return { status: "sent" };
  } catch (error) { return { status: "failed", error: getSafeError(error) }; }
}

export async function sendCourseDecisionEmail({ enrollment, course, decision, reason = "" }) {
  const sender = process.env.GMAIL_USER?.trim();
  const password = process.env.GMAIL_APP_PASSWORD;
  if (!sender || !password) return { status: "not_configured" };
  let mailer;
  try { mailer = getTransporter(); } catch { return { status: "not_configured" }; }
  const approved = decision === "approved";
  const rows = [
    ["Programme", course.title], ["Registration reference", enrollment.reference],
    ["Decision", approved ? "Approved" : "Not approved"],
    ...(approved ? [] : [["Reason", reason]]),
  ].filter(([, value]) => String(value || "").trim());
  const title = approved ? "Your registration is approved" : "An update about your registration";
  const text = [
    `Hello ${enrollment.student.name},`, "",
    approved
      ? `Your registration for ${course.title} has been approved. ProJenius will contact you by phone to coordinate the remaining arrangements. Please keep reference ${enrollment.reference} for support.`
      : `We could not approve your registration for ${course.title}. Reason: ${reason}. Please contact ProJenius if you need help. No refund has been issued by this decision; any refund request is handled separately under the applicable policy and law.`,
    ...rows.map(([label, value]) => `${label}: ${value}`),
  ].join("\n");
  const htmlRows = rows.map(([label, value]) => `<tr><th align="left" style="padding:9px;border-bottom:1px solid #e8eef5;color:#64748b">${escapeHtml(label)}</th><td style="padding:9px;border-bottom:1px solid #e8eef5">${escapeHtml(value)}</td></tr>`).join("");
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f2f6fb;color:#202938;padding:24px"><main style="max-width:620px;margin:auto;background:#fff;border:1px solid #dce5ef;border-radius:12px;padding:28px"><p style="color:#08b8d0;font-weight:bold">PROJENIUS LIVE TRAINING</p><h1 style="color:#0a347f;font-size:22px">${escapeHtml(title)}</h1><p>Hello ${escapeHtml(enrollment.student.name)},</p><p>${approved ? "Your paid registration has been approved. ProJenius will contact you by phone to coordinate the remaining arrangements." : "Your registration could not be approved. The reason is included below. A rejection does not itself create or confirm a refund."}</p><table style="width:100%;border-collapse:collapse">${htmlRows}</table><p>Reference: <strong>${escapeHtml(enrollment.reference)}</strong></p><p>Contact ProJenius through projenius.in if you need help.</p></main></body></html>`;
  try {
    await mailer.sendMail({
      from: `"ProJenius" <${sender}>`, to: enrollment.student.email,
      subject: `${title} · ${enrollment.reference}`, text, html,
    });
    return { status: "sent" };
  } catch (error) { return { status: "failed", error: getSafeError(error) }; }
}

function publicOrigin() {
  try {
    const origin = new URL(process.env.PUBLIC_SITE_ORIGIN || "");
    if (!["https:", "http:"].includes(origin.protocol) || (origin.protocol === "http:" && !["localhost", "127.0.0.1"].includes(origin.hostname))) return null;
    return origin.origin;
  } catch { return null; }
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
      const configuredApi = new URL(process.env.PUBLIC_API_ORIGIN || origin);
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
  const allowedOrigin = (value) => { try { const url = new URL(value); return (url.origin === origin || url.origin === new URL(process.env.PUBLIC_API_ORIGIN || origin).origin) && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))); } catch { return false; } };
  if (!allowedOrigin(unsubscribeUrl) || (listUnsubscribeUrl && !allowedOrigin(listUnsubscribeUrl))) return { status: "failed", error: "Unsubscribe URL is not on a configured public origin." };
  let safeUrl; let safeImage = "";
  try { safeUrl = new URL(content.url); if (safeUrl.origin !== origin) return { status: "failed", error: "Announcement URL is not on the configured public site." }; }
  catch { return { status: "failed", error: "Announcement URL is invalid." }; }
  if (content.image) { try { const imageUrl = new URL(content.image); const configuredApi = new URL(process.env.PUBLIC_API_ORIGIN || origin); const allowedImageOrigins = new Set([origin, configuredApi.origin]); const safeProtocol = imageUrl.protocol === "https:" || (imageUrl.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(imageUrl.hostname.toLowerCase())); if (allowedImageOrigins.has(imageUrl.origin) && safeProtocol && imageUrl.username === "" && imageUrl.password === "") safeImage = `<img src="${escapeHtml(imageUrl.href)}" alt="${escapeHtml(content.imageAlt || "")}" style="display:block;width:100%;max-width:100%;height:auto;border-radius:8px;margin:0 0 18px">`; } catch { /* optional image is omitted */ } }
  let mailer; try { mailer = getTransporter(); } catch { return { status: "not_configured" }; }
  const category = content.type !== "course" ? String(content.category || "").replace(/\s+/g, " ").trim().slice(0, 100) : "";
  const categoryText = category ? `Category: ${category}\n\n` : "";
  const categoryHtml = category ? `<p style="margin:0 0 12px;color:#64748b;font-size:13px">${escapeHtml(category)}</p>` : "";
  const text = `${categoryText}${content.title}\n\n${content.summary}\n\nRead more: ${safeUrl.href}\n\nUnsubscribe: ${unsubscribeUrl}`;
  const html = newsletterShell(content.title, `${safeImage}${categoryHtml}<p style="font-size:15px;line-height:1.7">${escapeHtml(content.summary)}</p><p><a href="${escapeHtml(safeUrl.href)}" style="display:inline-block;background:#0a347f;color:white;padding:12px 18px;border-radius:6px;text-decoration:none">${content.type === "course" ? "View Course" : "Read More"}</a></p><p style="margin-top:28px;color:#64748b;font-size:12px">You received this because you subscribed to ProJenius email updates. <a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a></p>`);
  const headers = listUnsubscribeUrl ? { "List-Unsubscribe": `<${listUnsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {};
  try { const result = await mailer.sendMail({ from: `"ProJenius" <${sender}>`, to: email, subject: `${content.type === "course" ? "New course" : content.type === "blog" ? "New blog" : "News & Insights"}: ${content.title}`, text, html, headers }); return { status: "sent", messageId: result.messageId }; }
  catch (error) { return { status: "failed", error: getSafeError(error) }; }
}
