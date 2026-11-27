/* npm run keepalive  — writes one "ProJenius" keep-alive entry now.
   Use it by hand, or from Windows Task Scheduler / any cron. */
import "dotenv/config";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { lastKeepAlive, runKeepAlive } from "../src/modules/keepalive/keepAlive.service.js";

try {
  await connectDatabase();
  const before = await lastKeepAlive();
  const result = await runKeepAlive({ source: "script", force: true });
  console.log(`Keep-alive entry written at ${new Date(result.last.createdAt).toLocaleString("en-IN")}.`);
  console.log(before ? `Previous entry: ${new Date(before.createdAt).toLocaleString("en-IN")}.` : "This is the first keep-alive entry.");
} catch (error) {
  console.error("Keep-alive failed:", error.message);
  process.exitCode = 1;
} finally {
  await disconnectDatabase().catch(() => {});
}
