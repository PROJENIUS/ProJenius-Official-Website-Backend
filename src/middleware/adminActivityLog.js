/* =========================================================
   PROJENIUS BACKEND — ADMIN ACTIVITY LOG
   Records every successful change made from the admin panel
   (create, edit, publish, delete…) so the Super Admin can see
   who changed what and when. Account and sign-in events are
   recorded separately by the auth and management controllers.
========================================================= */

import AdminAuditEvent from "../modules/admin/management/adminAudit.model.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Already audited in detail by their own controllers.
const SKIP = [/^\/api\/admin\/auth(\/|$)/, /^\/api\/admin\/admins(\/|$)/, /^\/api\/courses\/admin\/dashboard\//];

const AREAS = [
  [/^\/api\/courses\/admin\/enrollments/, "Enrollments"],
  [/^\/api\/courses\/admin\/notifications/, "Course notifications"],
  [/^\/api\/courses\/admin\/(policy|common-faqs)/, "Course settings"],
  [/^\/api\/courses\/admin/, "Courses"],
  [/^\/api\/admin\/enquiries/, "Enquiries"],
  [/^\/api\/admin\/job-applications/, "Career applications"],
  [/^\/api\/admin\/articles/, "News & Insights"],
  [/^\/api\/admin\/(newsletter|campaigns|subscribers)/, "Newsletter"],
  [/^\/api\/legal/, "Legal documents"],
  [/^\/api\/admin/, "Admin panel"],
];

const VERBS = { POST: "created", PUT: "saved", PATCH: "updated", DELETE: "deleted" };

function areaOf(path) {
  return AREAS.find(([pattern]) => pattern.test(path))?.[1] || "Admin panel";
}

function actionWord(req, path) {
  const tail = path.split("/").filter(Boolean).pop() || "";
  if (["publish", "state", "decision", "announce", "image", "retry"].includes(tail)) {
    return { publish: "published", state: "status changed", decision: "decision recorded", announce: "announced", image: "image uploaded", retry: "retried" }[tail];
  }
  return VERBS[req.method];
}

// A short, safe label for the changed item (never passwords or tokens).
function summaryOf(body) {
  if (!body || typeof body !== "object") return "";
  for (const key of ["title", "name", "slug", "status", "state", "decision", "action"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return `${key}: ${value.trim().slice(0, 120)}`;
  }
  return "";
}

export function adminActivityLog(req, res, next) {
  if (!MUTATING.has(req.method)) return next();
  const path = req.originalUrl.split("?")[0];
  if (SKIP.some((pattern) => pattern.test(path))) return next();

  res.on("finish", () => {
    if (!req.admin?.id || res.statusCode >= 400) return;
    AdminAuditEvent.create({
      actorId: req.admin.id,
      targetAdminId: null,
      action: "activity.change",
      metadata: {
        area: areaOf(path),
        change: actionWord(req, path),
        method: req.method,
        path,
        summary: summaryOf(req.body),
      },
    }).catch(() => {});
  });
  return next();
}
