const COURSE_FIELDS = new Set([
  "title", "slug", "shortDescription", "description", "category", "learningOutcomes",
  "curriculum", "duration", "deliveryMode", "audience", "prerequisites", "instructor",
  "startDate", "registrationDeadline", "timezone", "priceMinor", "listPriceMinor", "currency", "internalCostMinor", "enrollmentOpen", "deliveryDetails", "batches",
  "language", "level", "skills", "tools", "projects", "certificate", "premiumEligible", "faqs", "aboutContent", "highlights", "badgeType", "customBadgeLabel", "badges", "sessionLength", "sessionCount", "courseValidity", "prerequisitesDeclared", "noPrerequisites", "prerequisiteDetails", "experienceLevel", "reviews", "relatedCourseIds",
]);

function stringList(value, label, { maxItems = 30, maxLength = 120 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) throw new CourseValidationError(`${label} must contain at most ${maxItems} items.`);
  return value.map((item) => text(item, label, maxLength, { required: true }));
}

function secureOptionalUrl(value, label, maxLength = 1000) {
  const result = text(value ?? "", label, maxLength, { allowEmpty: true });
  if (!result) return "";
  let url;
  try { url = new URL(result); } catch { throw new CourseValidationError(`${label} must be a valid HTTPS URL.`); }
  if (url.protocol !== "https:") throw new CourseValidationError(`${label} must be a valid HTTPS URL.`);
  return url.href;
}

export class CourseValidationError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function endOfDayInTimezone(dateOnly, timezone) {
  const [year, month, day] = dateOnly.split("-").map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) {
    throw new CourseValidationError("Registration deadline is invalid.");
  }
  const target = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  let utc = target;
  let formatter;
  try { formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }); } catch { throw new CourseValidationError("Choose a valid IANA timezone."); }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(utc)).map(({ type, value }) => [type, value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second), 999);
    const correction = target - represented;
    if (!correction) break;
    utc += correction;
  }
  return new Date(utc);
}

function text(value, label, maxLength, { required = false, allowEmpty = false } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.trim().length > maxLength) {
    throw new CourseValidationError(`${label} is required and must be at most ${maxLength} characters.`);
  }
  return value.trim();
}

function sanitizeCourseRichText(value) {
  return value
    .replace(/<(script|style|iframe|object|svg)[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(?!p\b|br\b|strong\b|b\b|em\b|i\b|ul\b|ol\b|li\b)[a-z][^>]*>/gi, "")
    .replace(/<(p|br|strong|b|em|i|ul|ol|li)\b[^>]*>/gi, (tag) => `<${tag.match(/[a-z]+/i)[0].toLowerCase()}>`)
    .replace(/<\/(p|strong|b|em|i|ul|ol|li)\s*>/gi, (tag) => tag.toLowerCase());
}

function orderedEntries(value, label, { maxItems = 100, maxLength = 180, allowDescription = true } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) throw new CourseValidationError(`${label} must contain at most ${maxItems} items.`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new CourseValidationError(`${label} entry is invalid.`);
    const allowed = ["_id", "title", "description", "order"];
    if (Object.keys(entry).some((key) => !allowed.includes(key))) throw new CourseValidationError(`${label} entry contains unsupported fields.`);
    const order = entry.order === undefined ? index : entry.order;
    if (!Number.isSafeInteger(order) || order < 0) throw new CourseValidationError(`${label} order is invalid.`);
    const result = { title: text(entry.title, `${label} title`, maxLength, { required: true }), order };
    if (entry._id !== undefined) {
      if (!/^[a-f\d]{24}$/i.test(String(entry._id))) throw new CourseValidationError(`${label} identifier is invalid.`);
      result._id = entry._id;
    }
    if (allowDescription) result.description = text(entry.description ?? "", `${label} description`, 800, { allowEmpty: true });
    return result;
  });
}

function minorUnits(value, label, { required = false, allowZero = true } = {}) {
  if (value === undefined && !required) return undefined;
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new CourseValidationError(`${label} must be a valid integer amount in paise.`);
  }
  return value;
}

export function validateCourseInput(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CourseValidationError("Course details are invalid.");
  for (const key of Object.keys(input)) if (!COURSE_FIELDS.has(key)) throw new CourseValidationError(`Unsupported course field: ${key}.`);
  const output = {};
  const fields = [
    ["title", "Title", 180], ["slug", "Slug", 190], ["shortDescription", "Short description", 360],
    ["description", "Description", 15000], ["category", "Category", 100], ["duration", "Duration", 100],
    ["audience", "Audience", 1000, true], ["prerequisites", "Prerequisites", 2000, true],
  ];
  for (const [key, label, limit, allowEmpty] of fields) {
    const value = text(input[key], label, limit, { required: !partial && !["audience", "prerequisites"].includes(key), allowEmpty });
    if (value !== undefined) output[key] = value;
  }
  if (input.aboutContent !== undefined) {
    if (typeof input.aboutContent !== "string" || input.aboutContent.length > 5000) throw new CourseValidationError("About This Course content is invalid.");
    const safeContent = sanitizeCourseRichText(input.aboutContent);
    const plainLength = safeContent.replace(/<[^>]*>/g, "").length;
    if (plainLength > 1000) throw new CourseValidationError("About This Course must be at most 1000 characters.");
    output.aboutContent = safeContent;
  }
  if (input.highlights !== undefined || !partial) output.highlights = stringList(input.highlights ?? [], "Course highlight", { maxItems: 20, maxLength: 180 });
  if (input.badges !== undefined || !partial) {
    if (!Array.isArray(input.badges ?? []) || (input.badges ?? []).length > 2) throw new CourseValidationError("Add no more than two course badges.");
    output.badges = (input.badges ?? []).map((badge) => text(badge, "Course badge", 32, { required: true }));
  }
  if (input.badgeType !== undefined) {
    if (!["", "most-purchased", "trending", "top-rated", "other"].includes(input.badgeType)) throw new CourseValidationError("Choose a supported course badge.");
    output.badgeType = input.badgeType;
  }
  if (input.customBadgeLabel !== undefined) {
    output.customBadgeLabel = text(input.customBadgeLabel, "Custom badge label", 32, { allowEmpty: true });
  }
  if (input.badgeType === "other" && !input.customBadgeLabel?.trim()) {
    throw new CourseValidationError("Enter a custom badge label.");
  }
  if (input.badgeType && input.badgeType !== "other" && input.customBadgeLabel?.trim()) {
    throw new CourseValidationError("A custom label is only valid for the Other badge.");
  }
  for (const key of ["sessionLength", "courseValidity"]) {
    if (input[key] !== undefined) output[key] = text(input[key], key === "sessionLength" ? "Session length" : "Course validity", key === "sessionLength" ? 80 : 120, { allowEmpty: true });
  }
  if (input.sessionCount !== undefined) {
    if (input.sessionCount === null || input.sessionCount === "") output.sessionCount = null;
    else if (!Number.isSafeInteger(input.sessionCount) || input.sessionCount < 1 || input.sessionCount > 1000) throw new CourseValidationError("Session count must be a whole number from 1 to 1000.");
    else output.sessionCount = input.sessionCount;
  }
  for (const key of ["prerequisitesDeclared", "noPrerequisites"]) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean") throw new CourseValidationError(`${key} must be true or false.`);
      output[key] = input[key];
    }
  }
  if (input.prerequisiteDetails !== undefined || !partial) {
    const details = input.prerequisiteDetails ?? {};
    const keys = ["priorKnowledge", "eligibility", "equipment"];
    if (!details || typeof details !== "object" || Array.isArray(details) || Object.keys(details).some((key) => !keys.includes(key))) throw new CourseValidationError("Prerequisite details are invalid.");
    output.prerequisiteDetails = {};
    for (const key of keys) if (!partial || details[key] !== undefined) output.prerequisiteDetails[key] = text(details[key] ?? "", "Prerequisite detail", 300, { allowEmpty: true });
  }
  if (input.experienceLevel !== undefined) {
    if (!["", "beginner-friendly", "prior-experience", "all-levels"].includes(input.experienceLevel)) throw new CourseValidationError("Choose a supported experience level.");
    output.experienceLevel = input.experienceLevel;
  }
  if (input.relatedCourseIds !== undefined || !partial) {
    const ids = input.relatedCourseIds ?? [];
    if (!Array.isArray(ids) || ids.length > 30 || ids.some((id) => !/^[a-f\d]{24}$/i.test(String(id)))) throw new CourseValidationError("Related course selections are invalid.");
    output.relatedCourseIds = [...new Set(ids.map(String))];
  }
  if (input.reviews !== undefined || !partial) {
    const reviews = input.reviews ?? [];
    if (!Array.isArray(reviews) || reviews.length > 100) throw new CourseValidationError("Reviews must contain at most 100 items.");
    output.reviews = reviews.map((review, index) => {
      const allowed = ["_id", "studentName", "rating", "testimonial", "reviewDate", "photoUrl", "published", "order"];
      if (!review || typeof review !== "object" || Array.isArray(review) || Object.keys(review).some((key) => !allowed.includes(key))) throw new CourseValidationError("Review details are invalid.");
      if (review._id !== undefined && !/^[a-f\d]{24}$/i.test(String(review._id))) throw new CourseValidationError("Review identifier is invalid.");
      if (!Number.isInteger(review.rating) || review.rating < 1 || review.rating > 5) throw new CourseValidationError("Review rating must be from 1 to 5.");
      if (review.published !== undefined && typeof review.published !== "boolean") throw new CourseValidationError("Review publication state is invalid.");
      const reviewDate = new Date(review.reviewDate);
      if (Number.isNaN(reviewDate.getTime())) throw new CourseValidationError("Review date is invalid.");
      const order = review.order === undefined ? index : review.order;
      if (!Number.isSafeInteger(order) || order < 0) throw new CourseValidationError("Review order is invalid.");
      return { ...(review._id ? { _id: review._id } : {}), studentName: text(review.studentName, "Review name", 100, { required: true }), rating: review.rating, testimonial: text(review.testimonial, "Testimonial", 1500, { required: true }), reviewDate, photoUrl: secureOptionalUrl(review.photoUrl, "Review photo URL"), published: review.published ?? false, order };
    });
  }
  if (input.language !== undefined) output.language = text(input.language, "Language", 80, { allowEmpty: true });
  if (input.level !== undefined) {
    if (!["", "beginner", "intermediate", "advanced"].includes(input.level)) throw new CourseValidationError("Choose a supported course level.");
    output.level = input.level;
  }
  if (output.slug) {
    output.slug = output.slug.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!output.slug) throw new CourseValidationError("Slug must contain letters or numbers.");
  }
  if (input.deliveryMode !== undefined || !partial) {
    if (!["online", "in-person", "hybrid"].includes(input.deliveryMode)) throw new CourseValidationError("Delivery mode must be online, in-person, or hybrid.");
    output.deliveryMode = input.deliveryMode;
  }
  if (input.currency !== undefined && input.currency !== "INR") throw new CourseValidationError("Only INR course pricing is currently supported.");
  if (!partial || input.priceMinor !== undefined) output.priceMinor = minorUnits(input.priceMinor, "Price", { required: !partial });
  if (input.listPriceMinor !== undefined) output.listPriceMinor = input.listPriceMinor === null || input.listPriceMinor === "" ? null : minorUnits(input.listPriceMinor, "List price");
  if (input.listPriceMinor !== undefined && input.listPriceMinor !== null && input.priceMinor !== undefined && input.listPriceMinor < input.priceMinor) throw new CourseValidationError("Original price must not be lower than the offer price.");
  if (input.internalCostMinor !== undefined) output.internalCostMinor = minorUnits(input.internalCostMinor, "Internal cost");
  if (input.enrollmentOpen !== undefined) {
    if (typeof input.enrollmentOpen !== "boolean") throw new CourseValidationError("Enrollment availability must be true or false.");
    output.enrollmentOpen = input.enrollmentOpen;
  }
  if (input.startDate !== undefined) {
    const value = input.startDate === null || input.startDate === "" ? null : new Date(input.startDate);
    if (value && Number.isNaN(value.getTime())) throw new CourseValidationError("Course start date is invalid.");
    output.startDate = value;
  }
  if (input.registrationDeadline !== undefined) {
    const timezone = output.timezone || (typeof input.timezone === "string" ? input.timezone : "Asia/Kolkata");
    const dateOnly = typeof input.registrationDeadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.registrationDeadline);
    const value = input.registrationDeadline === null || input.registrationDeadline === "" ? null : dateOnly
      ? endOfDayInTimezone(input.registrationDeadline, timezone)
      : new Date(input.registrationDeadline);
    if (value && Number.isNaN(value.getTime())) throw new CourseValidationError("Registration deadline is invalid.");
    output.registrationDeadline = value;
  }
  if (input.timezone !== undefined || !partial) {
    const timezone = input.timezone === undefined ? "Asia/Kolkata" : text(input.timezone, "Timezone", 80, { required: true });
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new CourseValidationError("Choose a valid IANA timezone."); }
    output.timezone = timezone;
  }
  if (input.learningOutcomes !== undefined || !partial) {
    if (!Array.isArray(input.learningOutcomes ?? []) || (input.learningOutcomes ?? []).length > 30) throw new CourseValidationError("Learning outcomes must be a list of at most 30 items.");
    output.learningOutcomes = (input.learningOutcomes ?? []).map((value) => text(value, "Learning outcome", 300, { required: true }));
  }
  for (const key of ["skills", "tools"]) {
    if (input[key] !== undefined || !partial) output[key] = stringList(input[key] ?? [], key === "skills" ? "Skill" : "Tool", { maxItems: 30, maxLength: 120 });
  }
  if (input.curriculum !== undefined || !partial) {
    if (!Array.isArray(input.curriculum ?? []) || (input.curriculum ?? []).length > 80) throw new CourseValidationError("Curriculum must be a list of at most 80 modules.");
    output.curriculum = (input.curriculum ?? []).map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new CourseValidationError("Curriculum module is invalid.");
      const allowed = ["_id", "title", "description", "duration", "topics", "practicalActivities", "lessons"];
      if (Object.keys(item).some((key) => !allowed.includes(key))) throw new CourseValidationError("Curriculum module contains unsupported fields.");
      if (item._id !== undefined && !/^[a-f\d]{24}$/i.test(String(item._id))) throw new CourseValidationError("Curriculum module identifier is invalid.");
      const topics = item.topics === undefined ? [] : orderedEntries(item.topics, "Topic", { maxItems: 100 });
      const practicalActivities = item.practicalActivities === undefined ? [] : orderedEntries(item.practicalActivities, "Practical activity", { maxItems: 100 });
      const lessons = item.lessons ?? [];
      if (!Array.isArray(lessons) || lessons.length > 50) throw new CourseValidationError("Each module may contain at most 50 lessons.");
      return { title: text(item.title, "Curriculum title", 180, { required: true }), description: item.description === undefined ? "" : text(item.description, "Curriculum description", 1000, { allowEmpty: true }), duration: item.duration === undefined ? "" : text(item.duration, "Curriculum duration", 80, { allowEmpty: true }), lessons: lessons.map((lesson) => {
        if (!lesson || typeof lesson !== "object" || Array.isArray(lesson) || Object.keys(lesson).some((key) => !["_id", "title", "summary", "type", "duration", "resourceUrl"].includes(key))) throw new CourseValidationError("Curriculum lesson is invalid.");
        if (lesson._id !== undefined && !/^[a-f\d]{24}$/i.test(String(lesson._id))) throw new CourseValidationError("Curriculum lesson identifier is invalid.");
        const type = lesson.type || "reading";
        if (!["reading", "recorded-reference", "practical", "quiz"].includes(type)) throw new CourseValidationError("Curriculum lesson type is invalid.");
        return { ...(lesson._id ? { _id: lesson._id } : {}), title: text(lesson.title, "Lesson title", 180, { required: true }), summary: lesson.summary === undefined ? "" : text(lesson.summary, "Lesson summary", 800, { allowEmpty: true }), type, duration: lesson.duration === undefined ? "" : text(lesson.duration, "Lesson duration", 80, { allowEmpty: true }), resourceUrl: secureOptionalUrl(lesson.resourceUrl, "Lesson resource URL") };
      }), topics, practicalActivities, ...(item._id ? { _id: item._id } : {}) };
    });
  }
  if (input.projects !== undefined || !partial) {
    const projects = input.projects ?? [];
    if (!Array.isArray(projects) || projects.length > 20) throw new CourseValidationError("Projects must contain at most 20 items.");
    output.projects = projects.map((project, index) => {
      if (!project || typeof project !== "object" || Array.isArray(project) || Object.keys(project).some((key) => !["_id", "title", "description", "technologies", "outcome", "order"].includes(key))) throw new CourseValidationError("Project details are invalid.");
      if (project._id !== undefined && !/^[a-f\d]{24}$/i.test(String(project._id))) throw new CourseValidationError("Project identifier is invalid.");
      const order = project.order === undefined ? index : project.order;
      if (!Number.isSafeInteger(order) || order < 0) throw new CourseValidationError("Project order is invalid.");
      return { ...(project._id ? { _id: project._id } : {}), title: text(project.title, "Project title", 160, { required: true }), description: text(project.description ?? "", "Project description", 1200, { allowEmpty: true }), technologies: stringList(project.technologies ?? [], "Project technology", { maxItems: 20, maxLength: 80 }), outcome: text(project.outcome ?? "", "Project outcome", 500, { allowEmpty: true }), order };
    });
  }
  if (input.faqs !== undefined || !partial) {
    const faqs = input.faqs ?? [];
    if (!Array.isArray(faqs) || faqs.length > 30) throw new CourseValidationError("FAQs must contain at most 30 items.");
    output.faqs = faqs.map((faq, index) => {
      if (!faq || typeof faq !== "object" || Array.isArray(faq) || Object.keys(faq).some((key) => !["_id", "question", "answer", "order", "published"].includes(key))) throw new CourseValidationError("FAQ details are invalid.");
      if (faq._id !== undefined && !/^[a-f\d]{24}$/i.test(String(faq._id))) throw new CourseValidationError("FAQ identifier is invalid.");
      if (faq.published !== undefined && typeof faq.published !== "boolean") throw new CourseValidationError("FAQ publication state is invalid.");
      const order = faq.order === undefined ? index : faq.order;
      if (!Number.isSafeInteger(order) || order < 0) throw new CourseValidationError("FAQ order is invalid.");
      return { ...(faq._id ? { _id: faq._id } : {}), question: text(faq.question, "FAQ question", 300, { required: true }), answer: text(faq.answer, "FAQ answer", 1500, { required: true }), order, published: faq.published ?? true };
    });
  }
  if (input.certificate !== undefined || !partial) {
    const certificate = input.certificate ?? {};
    if (!certificate || typeof certificate !== "object" || Array.isArray(certificate) || Object.keys(certificate).some((key) => !["available", "description"].includes(key))) throw new CourseValidationError("Certificate details are invalid.");
    if (certificate.available !== undefined && typeof certificate.available !== "boolean") throw new CourseValidationError("Certificate availability must be true or false.");
    output.certificate = {};
    if (!partial || certificate.available !== undefined) output.certificate.available = certificate.available ?? false;
    if (!partial || certificate.description !== undefined) output.certificate.description = text(certificate.description ?? "", "Certificate description", 800, { allowEmpty: true });
  }
  if (input.premiumEligible !== undefined || !partial) {
    if (input.premiumEligible !== undefined && typeof input.premiumEligible !== "boolean") throw new CourseValidationError("Premium eligibility must be true or false.");
    output.premiumEligible = input.premiumEligible ?? false;
  }
  if (input.instructor !== undefined || !partial) {
    const instructor = input.instructor ?? {};
    if (!instructor || typeof instructor !== "object" || Array.isArray(instructor)) throw new CourseValidationError("Instructor details are invalid.");
    output.instructor = {};
    if (!partial || instructor.name !== undefined) output.instructor.name = instructor.name === undefined ? "" : text(instructor.name, "Instructor name", 120, { allowEmpty: true });
    if (!partial || instructor.designation !== undefined) output.instructor.designation = text(instructor.designation ?? "", "Instructor designation", 120, { allowEmpty: true });
    if (!partial || instructor.bio !== undefined) output.instructor.bio = instructor.bio === undefined ? "" : text(instructor.bio, "Instructor bio", 2000, { allowEmpty: true });
    if (!partial || instructor.expertise !== undefined) output.instructor.expertise = stringList(instructor.expertise ?? [], "Instructor expertise", { maxItems: 20, maxLength: 100 });
    if (!partial || instructor.profileUrl !== undefined) output.instructor.profileUrl = secureOptionalUrl(instructor.profileUrl, "Instructor profile URL", 500);
  }
  if (input.deliveryDetails !== undefined || !partial) {
    const details = input.deliveryDetails ?? {};
    const keys = ["onlinePlatform", "onlineJoinUrl", "onlineAccessCode", "venueName", "venueAddress", "reportingTime"];
    if (!details || typeof details !== "object" || Array.isArray(details) || Object.keys(details).some((key) => !keys.includes(key))) throw new CourseValidationError("Delivery instructions are invalid.");
    output.deliveryDetails = {};
    for (const key of keys) output.deliveryDetails[key] = details[key] === undefined ? "" : text(details[key], "Delivery instruction", key === "venueAddress" || key === "onlineJoinUrl" ? 1000 : key === "onlineAccessCode" ? 200 : 180, { allowEmpty: true });
    if (output.deliveryDetails.onlineJoinUrl) {
      let link;
      try { link = new URL(output.deliveryDetails.onlineJoinUrl); } catch { throw new CourseValidationError("Online joining link must be a valid HTTPS URL."); }
      if (link.protocol !== "https:") throw new CourseValidationError("Online joining link must be a valid HTTPS URL.");
    }
  }
  if (input.batches !== undefined || !partial) {
    const batches = input.batches ?? [];
    if (!Array.isArray(batches) || batches.length > 50) throw new CourseValidationError("Batches must be a list of at most 50 schedules.");
    const codes = new Set();
    output.batches = batches.map((batch) => {
      if (!batch || typeof batch !== "object" || Array.isArray(batch)) throw new CourseValidationError("Batch details are invalid.");
      const allowed = ["_id", "code", "label", "deliveryMode", "status", "startsAt", "endsAt", "timezone", "registrationOpensAt", "registrationClosesAt", "sessions"];
      if (Object.keys(batch).some((key) => !allowed.includes(key))) throw new CourseValidationError("Batch contains unsupported fields.");
      const code = text(batch.code, "Batch code", 80, { required: true }).toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(code) || codes.has(code)) throw new CourseValidationError("Batch codes must be unique and use letters, numbers, hyphens or underscores.");
      codes.add(code);
      if (batch._id !== undefined && !/^[a-f\d]{24}$/i.test(String(batch._id))) throw new CourseValidationError("Batch identifier is invalid.");
      const deliveryMode = batch.deliveryMode;
      if (!["online", "in-person", "hybrid"].includes(deliveryMode)) throw new CourseValidationError("Batch delivery mode is invalid.");
      const batchStatus = batch.status || "scheduled";
      if (!["scheduled", "rescheduled", "completed", "cancelled"].includes(batchStatus)) throw new CourseValidationError("Batch status is invalid.");
      const timezone = text(batch.timezone || input.timezone || "Asia/Kolkata", "Batch timezone", 80, { required: true });
      try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new CourseValidationError("Choose a valid batch timezone."); }
      const parseDate = (value, label, required = false) => {
        if ((value === undefined || value === null || value === "") && !required) return null;
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) throw new CourseValidationError(`${label} is invalid.`);
        return date;
      };
      const startsAt = parseDate(batch.startsAt, "Batch start date", true);
      const endsAt = parseDate(batch.endsAt, "Batch end date");
      const registrationOpensAt = parseDate(batch.registrationOpensAt, "Registration opening date");
      const registrationClosesAt = parseDate(batch.registrationClosesAt, "Registration closing date");
      if (endsAt && endsAt <= startsAt) throw new CourseValidationError("Batch end must be after its start.");
      if (registrationOpensAt && registrationClosesAt && registrationClosesAt < registrationOpensAt) throw new CourseValidationError("Registration closing must not be before it opens.");
      if (!Array.isArray(batch.sessions) || batch.sessions.length > 100) throw new CourseValidationError("Sessions must be a list of at most 100 entries.");
      const sessions = batch.sessions.map((session) => {
        if (!session || typeof session !== "object" || Array.isArray(session)) throw new CourseValidationError("Session details are invalid.");
        const sessionFields = ["_id", "title", "startsAt", "endsAt", "status", "onlinePlatform", "onlineJoinUrl", "onlineAccessCode", "venueName", "venueAddress", "reportingTime"];
        if (Object.keys(session).some((key) => !sessionFields.includes(key))) throw new CourseValidationError("Session contains unsupported fields.");
        if (session._id !== undefined && !/^[a-f\d]{24}$/i.test(String(session._id))) throw new CourseValidationError("Session identifier is invalid.");
        const title = text(session.title, "Session title", 160, { required: true });
        const sessionStartsAt = parseDate(session.startsAt, "Session start date", true);
        const sessionEndsAt = parseDate(session.endsAt, "Session end date");
        if (sessionEndsAt && sessionEndsAt <= sessionStartsAt) throw new CourseValidationError("Session end must be after its start.");
        const status = session.status || "scheduled";
        if (!["scheduled", "rescheduled", "completed", "cancelled"].includes(status)) throw new CourseValidationError("Session status is invalid.");
        const values = {};
        for (const key of sessionFields.slice(5)) values[key] = session[key] === undefined ? "" : text(session[key], "Session instruction", key === "onlineJoinUrl" || key === "venueAddress" ? 1000 : key === "onlineAccessCode" ? 200 : 180, { allowEmpty: true });
        if (values.onlineJoinUrl) {
          let url;
          try { url = new URL(values.onlineJoinUrl); } catch { throw new CourseValidationError("Session joining link must be a valid HTTPS URL."); }
          if (url.protocol !== "https:") throw new CourseValidationError("Session joining link must be a valid HTTPS URL.");
        }
        return { ...(session._id ? { _id: session._id } : {}), title, startsAt: sessionStartsAt, endsAt: sessionEndsAt, status, ...values };
      });
      return { ...(batch._id ? { _id: batch._id } : {}), code, label: text(batch.label, "Batch label", 120, { required: true }), deliveryMode, status: batchStatus, startsAt, endsAt, timezone, registrationOpensAt, registrationClosesAt, sessions };
    });
  }
  if (input.currency !== undefined) output.currency = "INR";
  return output;
}

export function validateCourseForPublishing(course) {
  const requireText = (value, label, limit) => {
    if (typeof value !== "string" || !value.trim() || value.trim().length > limit) throw new CourseValidationError(`${label} is required and must be at most ${limit} characters.`);
  };
  requireText(course?.title, "Course title", 70);
  requireText(course?.category, "Course category", 30);
  requireText(course?.shortDescription, "Short description", 160);
  requireText(course?.duration, "Course duration", 100);
  // Only what the public course page shows is required. Badge, session details,
  // prerequisites and experience level are optional.
  if (course.badgeType === "other") requireText(course.customBadgeLabel, "Custom badge label", 32);
  if (!["online", "in-person"].includes(course?.deliveryMode)) throw new CourseValidationError("Choose Online or Offline as the delivery mode before publishing.");
  if (!course?.coverImage?.mediaId && !course?.coverImage?.filename) throw new CourseValidationError("Upload a course thumbnail before publishing.");
  if (typeof course?.aboutContent !== "string" || !course.aboutContent.replace(/<[^>]*>/g, "").trim() || course.aboutContent.replace(/<[^>]*>/g, "").length > 1000) throw new CourseValidationError("Add About This Course content (up to 1000 characters) before publishing.");
  if (!Array.isArray(course?.curriculum) || !course.curriculum.some((module) => module?.title?.trim() && (module.topics?.some((topic) => topic.title?.trim()) || module.practicalActivities?.some((activity) => activity.title?.trim()) || module.lessons?.some((lesson) => lesson.title?.trim())))) throw new CourseValidationError("Add at least one module with a topic or practical activity before publishing.");
  if (!Array.isArray(course?.learningOutcomes) || !course.learningOutcomes.some((item) => typeof item === "string" && item.trim() && item.trim().length <= 120)) throw new CourseValidationError("Add at least one learning outcome (up to 120 characters) before publishing.");
  if (course.learningOutcomes.some((item) => typeof item !== "string" || !item.trim() || item.trim().length > 120)) throw new CourseValidationError("Each learning outcome must be at most 120 characters.");
  if (!Number.isSafeInteger(course.priceMinor) || course.priceMinor < 0 || !Number.isSafeInteger(course.listPriceMinor) || course.listPriceMinor < course.priceMinor) throw new CourseValidationError("Enter a valid original price that is at least the offer price.");
  if (typeof course.certificate?.available !== "boolean") throw new CourseValidationError("Choose whether a certificate is given before publishing.");
  return true;
}

export function validateStudentInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CourseValidationError("Student details are invalid.");
  const name = text(input.name, "Name", 120, { required: true });
  const email = text(input.email, "Email", 254, { required: true }).toLowerCase();
  const phone = text(input.phone, "Phone", 30, { required: true });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CourseValidationError("Enter a valid email address.");
  if (!/^\+?[0-9 ()-]{7,30}$/.test(phone)) throw new CourseValidationError("Enter a valid phone number.");
  const validDays = new Set(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
  const validSlots = new Set(["Morning", "Afternoon", "Evening"]);
  const preferredDays = input.preferredDays === undefined ? [] : input.preferredDays;
  const preferredTimeSlots = input.preferredTimeSlots === undefined ? [] : input.preferredTimeSlots;
  if (!Array.isArray(preferredDays) || preferredDays.length > 7 || preferredDays.some((day) => !validDays.has(day))) throw new CourseValidationError("Select valid preferred days.");
  if (!Array.isArray(preferredTimeSlots) || preferredTimeSlots.length > 3 || preferredTimeSlots.some((slot) => !validSlots.has(slot))) throw new CourseValidationError("Select valid preferred time slots.");
  const preferredMode = input.preferredMode === undefined || input.preferredMode === "" ? "" : input.preferredMode;
  if (!["", "online", "offline"].includes(preferredMode)) throw new CourseValidationError("Choose Online or Offline.");
  return { name, email, phone, preferredDays: [...new Set(preferredDays)], preferredTimeSlots: [...new Set(preferredTimeSlots)], preferredMode };
}
