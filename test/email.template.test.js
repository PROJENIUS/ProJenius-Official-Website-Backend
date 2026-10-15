import assert from "node:assert/strict";
import test from "node:test";

import { createSubmissionEmailMessages } from "../src/shared/email/index.js";

test("renders customer confirmation and administrator summary without sending email", () => {
  const { customerMessage, adminMessage } = createSubmissionEmailMessages({
    customerEmail: "synthetic@example.invalid",
    customerName: "Synthetic Applicant",
    referenceNumber: "PJ-ENQ-20261014-ABCDEF12",
    enquiryType: "general",
    answers: {
      name: "Synthetic Applicant",
      email: "synthetic@example.invalid",
      message: "Synthetic <script>content</script> for a safe template test.",
      password: "must-not-appear",
    },
    createdAt: new Date("2026-10-14T10:00:00.000Z"),
    pdfBuffer: Buffer.from("synthetic PDF"),
    adminEmail: "admin@example.invalid",
    fromEmail: "sender@example.invalid",
  });

  assert.match(customerMessage.text, /Hello Synthetic Applicant/);
  assert.match(customerMessage.text, /submitted successfully/);
  assert.match(customerMessage.html, /PJ-ENQ-20261014-ABCDEF12/);
  assert.match(customerMessage.html, /Your enquiry has been submitted successfully/);
  assert.doesNotMatch(customerMessage.html, /Synthetic &lt;script&gt;/);
  assert.equal(customerMessage.to, "synthetic@example.invalid");
  assert.equal(customerMessage.attachments[0].filename, "ProJenius-PJ-ENQ-20261014-ABCDEF12.pdf");

  assert.equal(adminMessage.to, "admin@example.invalid");
  assert.match(adminMessage.subject, /New General submission/);
  assert.match(adminMessage.html, /Submission summary/);
  assert.match(adminMessage.html, /Synthetic &lt;script&gt;content&lt;\/script&gt;/);
  assert.doesNotMatch(adminMessage.text, /must-not-appear/);
  assert.equal(adminMessage.attachments[0].content.toString(), "synthetic PDF");

  const unconfiguredAdminMessage = createSubmissionEmailMessages({
    customerEmail: "synthetic@example.invalid",
    customerName: "Synthetic Applicant",
    referenceNumber: "PJ-ENQ-20261014-ABCDEF12",
    enquiryType: "general",
    answers: {},
    pdfBuffer: Buffer.from("synthetic PDF"),
  }).adminMessage;
  assert.equal(unconfiguredAdminMessage.to, undefined);
});
