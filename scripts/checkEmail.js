
import "dotenv/config";
import { verifyEmailTransport } from "../src/shared/email/index.js";

try {
  await verifyEmailTransport();
  console.log("✅ Gmail SMTP connection verified successfully!");
} catch (error) {
  console.error("❌ Gmail SMTP verification failed.");
  console.error("Error:", error.message);
  process.exitCode = 1;
}
