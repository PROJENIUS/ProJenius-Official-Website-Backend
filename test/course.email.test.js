import assert from "node:assert/strict";
import test from "node:test";
import { sendCourseNotificationEmails, setEmailTransportForTests } from "../src/shared/email/email.service.js";

const envNames = ["NODE_ENV", "GMAIL_USER", "GMAIL_APP_PASSWORD", "ADMIN_NOTIFICATION_EMAIL"];
const savedEnvironment = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
test.after(() => {
  for (const key of envNames) {
    if (savedEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnvironment[key];
  }
});

const details = {
  reference: "PJ-CRS-SYNTHETIC-001",
  student: { name: "Synthetic Student", email: "student@example.invalid", phone: "+1 555 010 0130" },
  courseTitle: "Synthetic Course",
  amountMinor: 125000,
  paymentId: "pay_synthetic_email_test",
  paidAt: new Date("2026-10-14T10:00:00.000Z"),
  pdfBuffer: Buffer.from("synthetic PDF bytes"),
};

test("course email outcomes are separate and PDF is attached while delivery is stubbed", async () => {
  process.env.NODE_ENV = "test";
  process.env.GMAIL_USER = "sender@example.invalid";
  process.env.GMAIL_APP_PASSWORD = "synthetic-only-password";
  process.env.ADMIN_NOTIFICATION_EMAIL = "admin@example.invalid";
  const messages = [];
  const restore = setEmailTransportForTests({
    async sendMail(message) {
      messages.push(message);
      if (message.to === details.student.email) throw Object.assign(new Error("synthetic provider error"), { code: "ETEST" });
      return { messageId: "synthetic-message-id" };
    },
  });
  try {
    const result = await sendCourseNotificationEmails(details);
    assert.equal(result.customer.status, "failed");
    assert.equal(result.customer.error, "Email delivery failed (ETEST).");
    assert.equal(result.admin.status, "sent");
    assert.deepEqual(messages.map(({ to }) => to), [details.student.email, "admin@example.invalid"]);
    assert.equal(messages[0].attachments[0].content.toString(), "synthetic PDF bytes");
    assert.equal(messages[1].attachments[0].content.toString(), "synthetic PDF bytes");
    assert.match(messages[0].text, /contact you by phone/i);
    assert.match(messages[1].text, /contact the student by phone/i);
    assert.doesNotMatch(messages[0].text, /joining link|access code|venue/i);
  } finally {
    restore();
  }
});

test("missing Gmail configuration fails closed without initializing a transport", async () => {
  process.env.NODE_ENV = "test";
  delete process.env.GMAIL_USER;
  delete process.env.GMAIL_APP_PASSWORD;
  process.env.ADMIN_NOTIFICATION_EMAIL = "admin@example.invalid";
  let sendCalls = 0;
  const restore = setEmailTransportForTests({ async sendMail() { sendCalls += 1; } });
  try {
    const result = await sendCourseNotificationEmails(details);
    assert.deepEqual(result, { customer: { status: "not_configured" }, admin: { status: "not_configured" } });
    assert.equal(sendCalls, 0);
  } finally {
    restore();
  }
});

test("an unconfigured admin recipient is never replaced by a fallback recipient", async () => {
  process.env.NODE_ENV = "test";
  process.env.GMAIL_USER = "sender@example.invalid";
  process.env.GMAIL_APP_PASSWORD = "synthetic-only-password";
  delete process.env.ADMIN_NOTIFICATION_EMAIL;
  const recipients = [];
  const restore = setEmailTransportForTests({ async sendMail(message) { recipients.push(message.to); return { messageId: "synthetic-message-id" }; } });
  try {
    const result = await sendCourseNotificationEmails(details);
    assert.equal(result.customer.status, "sent");
    assert.equal(result.admin.status, "not_configured");
    assert.deepEqual(recipients, [details.student.email]);
  } finally {
    restore();
  }
});
