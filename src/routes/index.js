import authRoutes from "../modules/admin/auth/auth.routes.js";
import enquiryRoutes from "../modules/contacts/enquiry.routes.js";
import adminContactRoutes from "../modules/contacts/adminContact.routes.js";
import adminManagementRoutes from "../modules/admin/management/adminManagement.routes.js";
import courseRoutes from "../modules/courses/courses.routes.js";
import publishingRoutes from "../modules/publishing/publishing.routes.js";

/** Register the existing API groups without changing their public paths. */
export function registerApiRoutes(app) {
  app.use("/api/admin/auth", authRoutes);
  app.use("/api/admin/admins", adminManagementRoutes);
  app.use("/api/contact/enquiries", enquiryRoutes);
  app.use("/api/admin", adminContactRoutes);
  app.use("/api/courses", courseRoutes);
  app.use("/api", publishingRoutes);
}
