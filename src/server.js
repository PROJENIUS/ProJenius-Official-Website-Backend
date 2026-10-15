
/* =========================================================
   PROJENIUS BACKEND — SERVER ENTRY POINT
   Responsibility: Validate configuration and manage server
========================================================= */

import "dotenv/config";

import app, { closeSessionStore, initializeSessionStore } from "./app.js";
import {
  connectDatabase,
  disconnectDatabase,
  initializeDatabaseModels,
} from "./config/database.js";
import { startCoursePublicationScheduler, stopCoursePublicationScheduler } from "./modules/courses/courseScheduler.js";
import { startCourseNotificationWorker, stopCourseNotificationWorker } from "./modules/courses/courseNotificationQueue.service.js";
import { startPublishingWorker, stopPublishingWorker } from "./modules/publishing/publishing.service.js";

// SECTION: ENVIRONMENT VALIDATION
function validateEnvironment() {
  const requiredVariables = [
    "MONGODB_URI",
    "SESSION_SECRET",
    "ADMIN_SITE_ORIGIN",
  ];

  for (const name of requiredVariables) {
    if (!process.env[name]?.trim()) {
      throw new Error(
        `Missing required environment variable: ${name}`
      );
    }
  }

  if (
    Buffer.byteLength(process.env.SESSION_SECRET, "utf8") < 32
  ) {
    throw new Error(
      "SESSION_SECRET must contain at least 32 bytes."
    );
  }

  // SECTION: VALIDATE PORT
  const port = Number(process.env.PORT || 5000);

  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("PORT must be a valid TCP port.");
  }

  return port;
}

// SECTION: START SERVER AFTER DATABASE CONNECTION
async function startServer() {
  let server;

  try {
    const port = validateEnvironment();

    await connectDatabase();
    await initializeDatabaseModels();
    await initializeSessionStore();
    startCoursePublicationScheduler();
    startCourseNotificationWorker();
    startPublishingWorker();

    server = app.listen(port, () => {
      console.log(`ProJenius API listening on port ${port}`);
    });

    // SECTION: SERVER ERROR HANDLING
    server.on("error", () => {
      console.error("HTTP server error.");
      process.exitCode = 1;
    });

    // SECTION: GRACEFUL SHUTDOWN
    let isShuttingDown = false;

    const shutdown = (signal) => {
      if (isShuttingDown) {
        return;
      }

      isShuttingDown = true;
      stopCoursePublicationScheduler();
      stopPublishingWorker();

      console.log(`Received ${signal}. Starting shutdown.`);

      // Force exit if shutdown cannot finish in time.
      const forceExitTimer = setTimeout(() => {
        console.error(
          "Graceful shutdown timed out. Forcing exit."
        );

        process.exit(1);
      }, 10_000);

      forceExitTimer.unref();

      // Stop accepting new connections and wait for active
      // requests to finish.
      server.close(async (serverError) => {
        try {
          await stopCourseNotificationWorker();
          await closeSessionStore();
          await disconnectDatabase();

          clearTimeout(forceExitTimer);

          if (serverError) {
            console.error("HTTP server shutdown error.");

            process.exitCode = 1;
          } else {
            console.log("ProJenius API shut down cleanly.");
          }
        } catch {
          clearTimeout(forceExitTimer);

          console.error("Database shutdown failed.");

          process.exitCode = 1;
        }
      });
    };

    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  } catch {
    console.error("Backend startup failed. Check the required runtime configuration and database availability.");

    try {
      await disconnectDatabase();
    } catch {
      // Preserve the original startup failure.
    }

    process.exitCode = 1;
  }
}

// SECTION: BOOTSTRAP APPLICATION
startServer();
