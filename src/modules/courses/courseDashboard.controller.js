/* =========================================================
   PROJENIUS BACKEND — ADMIN DASHBOARD
   Only what the dashboard shows: money received and refunded
   per month, enrolments, and classes with start / end dates.
   Amounts are returned only to users who may see finances.
========================================================= */

import Course from "./course.model.js";
import CourseEnrollment from "./courseEnrollment.model.js";
import CoursePayment from "./coursePayment.model.js";
import CourseRefund from "./courseRefund.model.js";
import Enquiry from "../contacts/enquiry.model.js";
import JobApplication from "../careers/jobApplication.model.js";
import Admin from "../admin/auth/admin.model.js";

const PAID = ["captured", "partially_refunded", "refunded"];
const TZ = "Asia/Kolkata";

function lastMonths(count, now = new Date()) {
  const months = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

function classStatus(start, end, explicit, now) {
  if (explicit === "cancelled") return "cancelled";
  if (explicit === "completed") return "ended";
  if (end && end < now) return "ended";
  if (start && start > now) return "upcoming";
  if (start) return "ongoing";
  return "not_scheduled";
}

export async function adminDashboard(req, res, next) {
  try {
    const now = new Date();
    const months = lastMonths(12, now);
    const since = new Date(`${months[0]}-01T00:00:00+05:30`);
    const canSeeMoney = req.admin.role === "superadmin" || req.admin.permissions?.includes("courses:analytics:view") || req.admin.permissions?.includes("courses:payments:view");
    const monthKey = (field) => ({ $dateToString: { format: "%Y-%m", date: field, timezone: TZ } });

    const [received, refunds, refundTotals, enrolByMonth, enrolTotals, recentEnrolments, courses] = await Promise.all([
      CoursePayment.aggregate([
        { $match: { status: { $in: PAID }, capturedAt: { $gte: since } } },
        { $group: { _id: monthKey("$capturedAt"), amountMinor: { $sum: "$amountMinor" }, count: { $sum: 1 } } },
      ]),
      CourseRefund.aggregate([
        { $match: { status: "processed", createdAt: { $gte: since } } },
        { $group: { _id: monthKey({ $ifNull: ["$processedAt", "$createdAt"] }), amountMinor: { $sum: "$amountMinor" }, count: { $sum: 1 } } },
      ]),
      CourseRefund.aggregate([{ $group: { _id: "$status", amountMinor: { $sum: "$amountMinor" }, count: { $sum: 1 } } }]),
      CourseEnrollment.aggregate([
        { $match: { status: { $in: ["enrolled", "refunded"] }, paidAt: { $gte: since } } },
        { $group: { _id: monthKey("$paidAt"), count: { $sum: 1 } } },
      ]),
      CourseEnrollment.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      CourseEnrollment.find({ status: { $in: ["enrolled", "refunded"] } })
        .select("reference student.name courseSnapshot.title courseSnapshot.amountMinor paidAt status")
        .sort({ paidAt: -1, _id: -1 }).limit(8).lean(),
      Course.find({ status: { $in: ["published", "scheduled", "unpublished"] } })
        .select("title status startDate batches.label batches.status batches.startsAt batches.endsAt")
        .lean(),
    ]);

    const byMonth = (rows) => Object.fromEntries(rows.map((row) => [row._id, row]));
    const r = byMonth(received), f = byMonth(refunds), e = byMonth(enrolByMonth);
    const monthly = months.map((month) => ({
      month,
      ...(canSeeMoney ? { receivedMinor: r[month]?.amountMinor || 0, refundedMinor: f[month]?.amountMinor || 0 } : {}),
      enrolments: e[month]?.count || 0,
    }));

    const enrolCounts = Object.fromEntries(enrolTotals.map((row) => [row._id, row.count]));
    const refundMap = Object.fromEntries(refundTotals.map((row) => [row._id, row]));

    const classes = [];
    for (const course of courses) {
      const batches = (course.batches || []).filter((batch) => batch.startsAt);
      if (batches.length) {
        for (const batch of batches) {
          classes.push({ course: course.title, batch: batch.label, startsAt: batch.startsAt, endsAt: batch.endsAt || null, status: classStatus(new Date(batch.startsAt), batch.endsAt ? new Date(batch.endsAt) : null, batch.status, now) });
        }
      } else {
        classes.push({ course: course.title, batch: "", startsAt: course.startDate || null, endsAt: null, status: classStatus(course.startDate ? new Date(course.startDate) : null, null, null, now) });
      }
    }
    const order = { ongoing: 0, upcoming: 1, not_scheduled: 2, ended: 3, cancelled: 4 };
    classes.sort((a, b) => (order[a.status] - order[b.status]) || (new Date(a.startsAt || 0) - new Date(b.startsAt || 0)));
    const classCounts = classes.reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] || 0) + 1 }), {});

    // ---- Enquiries, career applications and orders ----
    const can = (permission) => req.admin.role === "superadmin" || req.admin.permissions?.includes(permission);
    const canEnquiries = can("enquiries:list");
    const canCareers = can("careerApplications:list");
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    // Each admin can clear their own bell; only items after that moment show again.
    const me = await Admin.findById(req.admin.id).select("notificationsClearedAt").lean();
    const clearedAt = me?.notificationsClearedAt || new Date(0);
    const unseen = { createdAt: { $gt: clearedAt }, $or: [{ isRead: false }, { status: "new" }] };
    const [enqMonthly, enqTypes, enqStatus, enqWeek, newEnquiries, jobStatus, newJobs, orderStatus, failedEmails] = await Promise.all([
      canEnquiries ? Enquiry.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: monthKey("$createdAt"), count: { $sum: 1 } } }]) : [],
      canEnquiries ? Enquiry.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: "$enquiryType", count: { $sum: 1 } } }]) : [],
      canEnquiries ? Enquiry.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]) : [],
      canEnquiries ? Enquiry.countDocuments({ createdAt: { $gte: weekAgo } }) : 0,
      canEnquiries ? Enquiry.find(unseen).select("referenceNumber enquiryType answers.name answers.fullName createdAt").sort({ createdAt: -1 }).limit(6).lean() : [],
      canCareers ? JobApplication.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]) : [],
      canCareers ? JobApplication.find(unseen).select("referenceNumber answers.name answers.fullName answers.role answers.position createdAt").sort({ createdAt: -1 }).limit(4).lean() : [],
      CoursePayment.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
      canEnquiries ? Enquiry.find({ createdAt: { $gt: clearedAt }, $or: [{ emailStatus: "failed" }, { customerEmailStatus: "failed" }, { adminEmailStatus: "failed" }] }).select("referenceNumber enquiryType answers.name answers.fullName createdAt").sort({ createdAt: -1 }).limit(4).lean() : [],
    ]);
    const em = byMonth(enqMonthly);
    monthly.forEach((row) => { if (canEnquiries) row.enquiries = em[row.month]?.count || 0; });
    const es = Object.fromEntries(enqStatus.map((row) => [row._id, row.count]));
    const js = Object.fromEntries(jobStatus.map((row) => [row._id, row.count]));
    const os = Object.fromEntries(orderStatus.map((row) => [row._id, row.count]));
    const who = (item) => item.answers?.name || item.answers?.fullName || "Someone";
    const notifications = [
      ...newEnquiries.map((item) => ({ kind: "enquiry", title: `New ${item.enquiryType} enquiry`, who: who(item), reference: item.referenceNumber, at: item.createdAt })),
      ...failedEmails.map((item) => ({ kind: "email", title: `Email failed: ${item.enquiryType} enquiry`, who: who(item), reference: item.referenceNumber, at: item.createdAt })),
      ...newJobs.map((item) => ({ kind: "career", title: "New career application", who: who(item), reference: item.referenceNumber, at: item.createdAt })),
      ...recentEnrolments.filter((item) => item.status === "enrolled" && new Date(item.paidAt) > clearedAt).slice(0, 4).map((item) => ({ kind: "enrolment", title: "New paid enrolment", who: item.student?.name || "Student", reference: item.reference, at: item.paidAt })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 8);

    res.set("Cache-Control", "no-store");
    return res.json({ item: {
      canSeeMoney,
      monthly,
      totals: {
        ...(canSeeMoney ? {
          receivedMinor: received.reduce((n, row) => n + row.amountMinor, 0),
          refundedMinor: refundMap.processed?.amountMinor || 0,
        } : {}),
        refundsProcessed: refundMap.processed?.count || 0,
        refundsPending: (refundMap.pending?.count || 0) + (refundMap.requested?.count || 0),
        refundsFailed: refundMap.failed?.count || 0,
        enrolled: (enrolCounts.enrolled || 0) + (enrolCounts.refunded || 0),
        enrolledThisMonth: e[months[months.length - 1]]?.count || 0,
        classesOngoing: classCounts.ongoing || 0,
        classesUpcoming: classCounts.upcoming || 0,
        classesEnded: classCounts.ended || 0,
      },
      recentEnrolments: recentEnrolments.map((item) => ({
        reference: item.reference, student: item.student?.name || "", course: item.courseSnapshot?.title || "",
        ...(canSeeMoney ? { amountMinor: item.courseSnapshot?.amountMinor || 0 } : {}),
        paidAt: item.paidAt, status: item.status,
      })),
      classes: classes.slice(0, 50),
      enquiries: canEnquiries ? {
        total: Object.values(es).reduce((n, v) => n + v, 0), new: es.new || 0, inProgress: es.in_progress || 0, resolved: (es.resolved || 0) + (es.closed || 0), lastWeek: enqWeek,
        byType: enqTypes.map((row) => ({ type: row._id, count: row.count })).sort((a, b) => b.count - a.count),
      } : null,
      careers: canCareers ? { total: Object.values(js).reduce((n, v) => n + v, 0), new: js.new || 0, shortlisted: js.shortlisted || 0 } : null,
      orders: { paid: (os.captured || 0) + (os.partially_refunded || 0) + (os.refunded || 0), failed: (os.failed || 0) + (os.cancelled || 0), pending: (os.created || 0) + (os.pending || 0) + (os.authorized || 0) },
      notifications,
    } });
  } catch (error) { return next(error); }
}

export async function clearDashboardNotifications(req, res, next) {
  try {
    const clearedAt = new Date();
    await Admin.updateOne({ _id: req.admin.id }, { $set: { notificationsClearedAt: clearedAt } });
    return res.json({ clearedAt });
  } catch (error) { return next(error); }
}
