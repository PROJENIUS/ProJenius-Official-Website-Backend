import assert from "node:assert/strict";
import test from "node:test";
import { CourseValidationError, validateCourseForPublishing, validateCourseInput } from "../src/modules/courses/courses.validation.js";

const validCourse = () => ({
  title: "Synthetic course", category: "Synthetic", shortDescription: "Synthetic course description",
  duration: "8 weeks", sessionLength: "90 minutes", sessionCount: 8,
  coverImage: { filename: "synthetic.webp" }, aboutContent: "<p>Synthetic course overview.</p>",
  curriculum: [{ title: "Foundations", topics: [{ title: "Core concepts" }] }],
  learningOutcomes: ["Build a synthetic project"], prerequisitesDeclared: true, noPrerequisites: true,
  experienceLevel: "beginner-friendly", priceMinor: 10000, listPriceMinor: 10000, premiumEligible: false,
  badgeType: "most-purchased", deliveryMode: "online", certificate: { available: true },
});

test("publishing accepts a complete course with equal original and offer prices and safe Premium default", () => {
  assert.equal(validateCourseForPublishing(validCourse()), true);
});

test("publishing requires an original price and does not infer one", () => {
  const course = validCourse();
  course.listPriceMinor = null;
  assert.throws(() => validateCourseForPublishing(course), CourseValidationError);
});

test("publishing only requires what the course page shows", () => {
  const course = validCourse();
  for (const key of ["premiumEligible", "sessionLength", "sessionCount", "prerequisitesDeclared", "noPrerequisites", "experienceLevel", "badgeType"]) delete course[key];
  assert.equal(validateCourseForPublishing(course), true);
});

test("publishing needs Online or Offline delivery and a certificate choice", () => {
  assert.throws(() => validateCourseForPublishing({ ...validCourse(), deliveryMode: "hybrid" }), /Online or Offline/);
  assert.equal(validateCourseForPublishing({ ...validCourse(), deliveryMode: "in-person" }), true);
  assert.throws(() => validateCourseForPublishing({ ...validCourse(), certificate: {} }), /certificate/i);
});

test("course input accepts explicit Premium eligibility and allows equal original and offer prices", () => {
  assert.equal(validateCourseInput({ premiumEligible: true }, { partial: true }).premiumEligible, true);
  assert.equal(validateCourseInput({ premiumEligible: false }, { partial: true }).premiumEligible, false);
  assert.throws(() => validateCourseInput({ premiumEligible: "eligible" }, { partial: true }), CourseValidationError);
  assert.throws(() => validateCourseInput({ listPriceMinor: 9000, priceMinor: 10000 }, { partial: true }), CourseValidationError);
});

test("course badges accept the featured choices and validate custom text", () => {
  assert.equal(validateCourseInput({ badgeType: "most-purchased" }, { partial: true }).badgeType, "most-purchased");
  assert.deepEqual(validateCourseInput({ badgeType: "other", customBadgeLabel: "New programme" }, { partial: true }), { badgeType: "other", customBadgeLabel: "New programme" });
  assert.throws(() => validateCourseInput({ badgeType: "other" }, { partial: true }), /custom badge label/i);
  assert.throws(() => validateCourseInput({ badgeType: "invented" }, { partial: true }), /supported course badge/i);
});

test("a custom badge still needs its label", () => {
  assert.throws(() => validateCourseForPublishing({ ...validCourse(), badgeType: "other" }), /custom badge label/i);
});
