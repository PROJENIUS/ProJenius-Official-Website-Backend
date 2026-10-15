import Course from "./course.model.js";
import CourseEnrollment from "./courseEnrollment.model.js";
import { enqueuePaymentNotifications, processCourseNotificationWorkerOnce, setCourseNotificationQueueRuntimeForTests } from "./courseNotificationQueue.service.js";

export function setCourseNotificationRuntimeForTests(runtime) {
  return setCourseNotificationQueueRuntimeForTests(runtime);
}

export async function processVerifiedCourseEnrollment(enrollmentId, payment) {
  const enrollment = await CourseEnrollment.findById(enrollmentId).lean();
  if (!enrollment || enrollment.status !== "enrolled") return;
  const course = await Course.findById(enrollment.courseId).lean();
  if (!course) return;
  await enqueuePaymentNotifications(enrollment, course, payment);
  await processCourseNotificationWorkerOnce();
}
