export const PERMISSIONS = Object.freeze([
  "dashboard:view",
  "enquiries:list",
  "enquiries:details",
  "enquiries:changeStatus",
  "enquiries:download",
  "careerApplications:list",
  "careerApplications:details",
  "careerApplications:changeStatus",
  "careerApplications:download",
  "courses:list",
  "courses:view",
  "courses:create",
  "courses:edit",
  "courses:uploadImage",
  "courses:schedule",
  "courses:publish",
  "courses:unpublish",
  "courses:archive",
  "courses:enrollments:view",
  "courses:enrollments:details",
  "courses:enrollments:approve",
  "courses:enrollments:reject",
  "courses:notifications:retry",
  "courses:notifications:view",
  "courses:payments:view",
  "courses:analytics:view",
  "courses:reports:export",
  "courses:refunds:view",
  "publishing:articles:list", "publishing:articles:view", "publishing:articles:create", "publishing:articles:edit", "publishing:articles:publish", "publishing:articles:schedule", "publishing:articles:archive", "publishing:articles:uploadImage", "publishing:campaigns:create",
  "newsletter:subscribers:view", "newsletter:campaigns:view", "newsletter:campaigns:retry", "newsletter:campaigns:cancel",
]);

// New regular administrators can work with existing contact operations. The
// settings, invitations, and account lifecycle remain Super Admin only.
export const DEFAULT_ADMIN_PERMISSIONS = Object.freeze([
  "dashboard:view",
  "enquiries:list",
  "enquiries:details",
  "enquiries:changeStatus",
  "enquiries:download",
  "careerApplications:list",
  "careerApplications:details",
  "careerApplications:changeStatus",
  "careerApplications:download",
]);

// Accounts created before explicit permissions retain their prior operational
// contact access until a Super Admin assigns a specific permission set.
export const LEGACY_ADMIN_PERMISSIONS = DEFAULT_ADMIN_PERMISSIONS;

export function normalizePermissions(value, fallback = []) {
  if (!Array.isArray(value)) return [...fallback];
  return [...new Set(value)].filter((permission) => PERMISSIONS.includes(permission));
}

export function isValidPermissionList(value) {
  return Array.isArray(value) && value.every((permission) => PERMISSIONS.includes(permission));
}

export function requirePermission(permission) {
  return function permissionGuard(req, res, next) {
    if (req.admin?.role === "superadmin") return next();
    const permissions = Array.isArray(req.admin?.permissions)
      ? req.admin.permissions
      : LEGACY_ADMIN_PERMISSIONS;
    if (permissions.includes(permission)) return next();
    return res.status(403).json({ error: "You do not have permission to perform this action." });
  };
}

export function requireAnyPermission(...requiredPermissions) {
  return function permissionGuard(req, res, next) {
    if (req.admin?.role === "superadmin") return next();
    const permissions = Array.isArray(req.admin?.permissions)
      ? req.admin.permissions
      : LEGACY_ADMIN_PERMISSIONS;
    if (requiredPermissions.some((permission) => permissions.includes(permission))) return next();
    return res.status(403).json({ error: "You do not have permission to perform this action." });
  };
}

export function requireSuperAdmin(req, res, next) {
  if (req.admin?.role === "superadmin") return next();
  return res.status(403).json({ error: "Only a Super Admin can manage administrator accounts." });
}
