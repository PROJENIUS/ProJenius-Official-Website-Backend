/* =========================================================
   PROJENIUS BACKEND — DATABASE CONFIGURATION
   Responsibility: Establish the MongoDB connection
========================================================= */

import mongoose from "mongoose";

// Keep the application and Mongo-backed sessions on the same fresh database.
export const DATABASE_NAME = "ProJeniusBackend";

// SECTION: CONNECT TO MONGODB
export async function connectDatabase() {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error("MONGODB_URI is not configured.");
  }

  await mongoose.connect(mongoUri, {
    dbName: DATABASE_NAME,
    serverSelectionTimeoutMS: 10000,
  });

  if (mongoose.connection.name !== DATABASE_NAME) {
    await mongoose.disconnect();
    throw new Error("MongoDB connected to an unexpected database.");
  }

  console.log("MongoDB connection established.");
}

// Create collections and declared indexes without dropping existing indexes.
export async function initializeDatabaseModels() {
  const models = [
    (await import("../modules/admin/auth/admin.model.js")).default,
    (await import("../modules/admin/auth/adminInvitation.model.js")).default,
    (await import("../modules/admin/auth/passwordReset.model.js")).default,
    (await import("../modules/admin/management/adminAudit.model.js")).default,
    (await import("../modules/contacts/enquiry.model.js")).default,
    (await import("../modules/careers/index.js")).JobApplication,
    (await import("../modules/courses/course.model.js")).default,
    (await import("../modules/courses/courseEnrollment.model.js")).default,
    (await import("../modules/courses/coursePayment.model.js")).default,
    (await import("../modules/courses/courseRefund.model.js")).default,
    (await import("../modules/courses/courseAudit.model.js")).default,
    (await import("../modules/courses/courseWebhookEvent.model.js")).default,
    (await import("../modules/courses/courseNotificationJob.model.js")).default,
    (await import("../modules/courses/courseReceipt.model.js")).default,
    (await import("../modules/publishing/contentArticle.model.js")).default,
    (await import("../modules/publishing/newsletterSubscriber.model.js")).default,
    (await import("../modules/publishing/newsletterCampaign.model.js")).default,
    (await import("../modules/publishing/newsletterDelivery.model.js")).default,
    (await import("../modules/publishing/publicationEvent.model.js")).default,
  ];

  for (const Model of models) {
    await Model.createCollection().catch((error) => {
      if (error.codeName !== "NamespaceExists" && error.code !== 48) throw error;
    });
    await Model.createIndexes();
  }
}

// SECTION: DISCONNECT FROM MONGODB
export async function disconnectDatabase() {
  await mongoose.disconnect();
}
