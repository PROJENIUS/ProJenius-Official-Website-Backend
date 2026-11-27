import authRoutes from "../modules/admin/auth/auth.routes.js";
import enquiryRoutes from "../modules/contacts/enquiry.routes.js";
import adminContactRoutes from "../modules/contacts/adminContact.routes.js";
import adminManagementRoutes from "../modules/admin/management/adminManagement.routes.js";
import courseRoutes from "../modules/courses/courses.routes.js";
import publishingRoutes from "../modules/publishing/publishing.routes.js";
import legalDocumentRoutes from "../modules/legal/legalDocuments.routes.js";
import googleReviewsRoutes from "../modules/googleReviews/googleReviews.routes.js";
import guidanceRoutes from "../modules/guidance/guidance.routes.js";
import keepAliveRoutes from "../modules/keepalive/keepAlive.routes.js";
import homeHeroRoutes from "../modules/homepage/homeHero.routes.js";
import pageHeroRoutes from "../modules/pageheroes/pageHero.routes.js";
import careersRoutes from "../modules/careers/careers.routes.js";

/** Register the existing API groups without changing their public paths. */
export function registerApiRoutes(app) {
  app.use("/api/admin/auth", authRoutes);
  app.use("/api/admin/admins", adminManagementRoutes);
  app.use("/api/contact/enquiries", enquiryRoutes);
  app.use("/api/admin", adminContactRoutes);
  app.use("/api/courses", courseRoutes);
  app.use("/api/guidance", guidanceRoutes);
  app.use("/api/home", homeHeroRoutes);
  app.use("/api/page-heroes", pageHeroRoutes);
  app.use("/api/careers", careersRoutes);
  app.use("/api/keepalive", keepAliveRoutes);
  app.use("/api/legal", legalDocumentRoutes);
  app.use("/api/reviews", googleReviewsRoutes);
  app.use("/api", publishingRoutes);
}
