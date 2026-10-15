import Course from "./course.model.js";
import CourseAudit from "./courseAudit.model.js";

let timer;
let running = false;

export async function runCoursePublicationScan(now = new Date()) {
  if (running) return;
  running = true;
  try {
    const due = await Course.find({ status: "scheduled", scheduledAt: { $lte: now } }).select("_id title slug scheduledAt scheduledBy").limit(100).lean();
    for (const course of due) {
      const updated = await Course.updateOne({ _id: course._id, status: "scheduled", scheduledAt: { $lte: now } }, { $set: { status: "published", publishedAt: now, publishedBy: course.scheduledBy || null, scheduleAuditPending: true, announcementStatus: "pending" } });
      if (!updated.modifiedCount) continue;
      try {
        const eventKey = `scheduled-publish:${course._id}:${new Date(course.scheduledAt).getTime()}`;
        await CourseAudit.updateOne({ eventKey }, { $setOnInsert: { eventKey, courseId: course._id, actorId: course.scheduledBy || null, action: "course.scheduledPublished", changes: { from: "scheduled", to: "published", scheduledAt: course.scheduledAt, publishedAt: now }, createdAt: now } }, { upsert: true });
        await Course.updateOne({ _id: course._id, scheduleAuditPending: true }, { $set: { scheduleAuditPending: false } });
      } catch {
        // Leave scheduleAuditPending set. The next scan retries audit repair.
      }
    }
    const pending = await Course.find({ scheduleAuditPending: true, status: "published" }).select("_id scheduledAt scheduledBy").limit(100).lean();
    for (const course of pending) {
      try {
        const eventKey = `scheduled-publish:${course._id}:${new Date(course.scheduledAt).getTime()}`;
        await CourseAudit.updateOne({ eventKey }, { $setOnInsert: { eventKey, courseId: course._id, actorId: course.scheduledBy || null, action: "course.scheduledPublished", changes: { from: "scheduled", to: "published", scheduledAt: course.scheduledAt }, createdAt: now } }, { upsert: true });
        await Course.updateOne({ _id: course._id, scheduleAuditPending: true }, { $set: { scheduleAuditPending: false } });
      } catch { /* retried on the next scan */ }
    }
  } finally { running = false; }
}

export function startCoursePublicationScheduler() {
  if (timer) return;
  void runCoursePublicationScan().catch(() => {});
  timer = setInterval(() => { void runCoursePublicationScan().catch(() => {}); }, 60_000);
  timer.unref?.();
}
export function stopCoursePublicationScheduler() { if (timer) clearInterval(timer); timer = undefined; }
