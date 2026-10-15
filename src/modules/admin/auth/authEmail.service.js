import nodemailer from "nodemailer";

let transporter;
let testSender = null;

function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("Mail service is not configured.");
  transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass: pass.replace(/\s/g, "") } });
  return transporter;
}

export function setAuthEmailSenderForTests(sender) {
  if (process.env.NODE_ENV !== "test" || typeof sender !== "function") {
    throw new Error("Auth email stubbing is available only in tests.");
  }
  const previous = testSender;
  testSender = sender;
  return () => { testSender = previous; };
}

async function send({ to, subject, text }) {
  if (process.env.NODE_ENV === "test") {
    if (!testSender) throw new Error("Auth email test sender is not configured.");
    return testSender({ to, subject, text });
  }
  return getTransporter().sendMail({
    from: `"ProJenius Admin" <${process.env.GMAIL_USER}>`, to, subject, text,
  });
}

export function sendInvitationEmail({ to, name, link }) {
  return send({
    to,
    subject: "Your ProJenius administrator invitation",
    text: `Hello ${name},\n\nUse this one-time link to create your ProJenius administrator account. It expires in 24 hours:\n${link}\n\nIf you did not expect this invitation, you can ignore this message.`,
  });
}

export function sendPasswordResetEmail({ to, name, link }) {
  return send({
    to,
    subject: "Reset your ProJenius administrator password",
    text: `Hello ${name || "Administrator"},\n\nUse this one-time link to reset your ProJenius password. It expires in 30 minutes:\n${link}\n\nIf you did not request this, you can ignore this message.`,
  });
}
