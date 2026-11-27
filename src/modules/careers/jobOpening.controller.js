/* =========================================================
   JOB OPENINGS — CONTROLLER
   Public:  GET  /api/careers/openings            open roles
            GET  /api/careers/openings/:slug      one open role
   Admin:   GET  /api/careers/admin/openings      all roles + application counts
            POST /api/careers/admin/openings      create
            PUT  /api/careers/admin/openings/:id  update (needs updatedAt)
            DELETE /api/careers/admin/openings/:id  delete a draft or closed role
   A role is public while its status is "open" and its closing
   date (if any) has not passed.
========================================================= */

import mongoose from "mongoose";
import JobOpening from "./jobOpening.model.js";
import JobApplication from "./jobApplication.model.js";
import { JOB_OPENING_RULES as RULES } from "./jobOpening.rules.js";

class InputError extends Error {}
const invalid = (message) => { throw new InputError(message); };
const FIELDS = ["title", "department", "employmentType", "workMode", "location", "experience", "salary", "positions", "summary", "responsibilities", "requirements", "niceToHave", "benefits", "skills", "status", "closesOn", "updatedAt"];

function cleanText(value, rule) {
  if (typeof value !== "string") invalid(`${rule.label} is required.`);
  // eslint-disable-next-line no-control-regex
  const textValue = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (textValue.length < rule.min || textValue.length > rule.max) invalid(`${rule.label} must be ${rule.min}–${rule.max} characters (now ${textValue.length}).`);
  return textValue;
}

function cleanList(value, rule) {
  if (!Array.isArray(value)) invalid(`${rule.label} is invalid.`);
  const items = value.map((item) => (typeof item === "string" ? item.replace(/\s+/g, " ").trim() : "")).filter(Boolean);
  if (items.length < rule.min || items.length > rule.max) invalid(`${rule.label}: give ${rule.min === 0 ? `up to ${rule.max}` : `${rule.min}–${rule.max}`} points.`);
  for (const item of items) if (item.length > rule.itemMax) invalid(`${rule.label}: each point must be ${rule.itemMax} characters or fewer.`);
  return items;
}

const slugify = (value) => value.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "role";

export function validateOpening(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("Job opening is invalid.");
  const unknown = Object.keys(body).find((key) => !FIELDS.includes(key));
  if (unknown) invalid(`“${unknown}” is not a job opening field.`);
  const out = {};
  for (const [name, rule] of Object.entries(RULES.text)) out[name] = cleanText(body[name] ?? (rule.min === 0 ? "" : body[name]), rule);
  for (const [name, rule] of Object.entries(RULES.lists)) out[name] = cleanList(body[name] ?? [], rule);
  if (!RULES.employmentTypes.includes(body.employmentType)) invalid("Choose the job type.");
  if (!RULES.workModes.includes(body.workMode)) invalid("Choose where the work happens.");
  if (!RULES.statuses.includes(body.status)) invalid("Choose the status.");
  const positions = Number(body.positions);
  if (!Number.isInteger(positions) || positions < RULES.positions.min || positions > RULES.positions.max) invalid(`Openings must be ${RULES.positions.min}–${RULES.positions.max}.`);
  let closesOn = null;
  if (body.closesOn) {
    closesOn = new Date(`${String(body.closesOn).slice(0, 10)}T23:59:59+05:30`);
    if (Number.isNaN(closesOn.getTime())) invalid("The closing date is invalid.");
  }
  return { ...out, employmentType: body.employmentType, workMode: body.workMode, status: body.status, positions, closesOn };
}

const isPublic = () => ({ status: "open", $or: [{ closesOn: null }, { closesOn: { $gte: new Date() } }] });

function publicShape(item) {
  return {
    slug: item.slug, title: item.title, department: item.department, employmentType: item.employmentType, workMode: item.workMode,
    location: item.location, experience: item.experience, salary: item.salary, positions: item.positions, summary: item.summary,
    responsibilities: item.responsibilities, requirements: item.requirements, niceToHave: item.niceToHave, benefits: item.benefits,
    skills: item.skills, postedAt: item.postedAt, closesOn: item.closesOn, updatedAt: item.updatedAt,
  };
}

const respond = (res, error, next) => {
  if (error instanceof InputError) return res.status(400).json({ error: error.message });
  if (error?.code === 11000) return res.status(409).json({ error: "Another role already has this title. Change the title a little." });
  if (error instanceof mongoose.Error.ValidationError) return res.status(400).json({ error: "Job opening is invalid." });
  return next(error);
};

export async function listPublicOpenings(_req, res, next) {
  try {
    const items = await JobOpening.find(isPublic()).sort({ postedAt: -1, _id: -1 }).limit(100).lean();
    res.set("Cache-Control", "public, max-age=60");
    return res.json({ items: items.map(publicShape) });
  } catch (error) {
    return next(error);
  }
}

export async function getPublicOpening(req, res, next) {
  try {
    const item = await JobOpening.findOne({ slug: String(req.params.slug || "").toLowerCase().slice(0, 90), ...isPublic() }).lean();
    if (!item) return res.status(404).json({ error: "This role is not open right now." });
    res.set("Cache-Control", "public, max-age=60");
    return res.json({ item: publicShape(item) });
  } catch (error) {
    return next(error);
  }
}

export async function listAdminOpenings(_req, res, next) {
  try {
    const [items, counts] = await Promise.all([
      JobOpening.find().sort({ updatedAt: -1 }).limit(200).lean(),
      JobApplication.aggregate([{ $match: { "answers.openingSlug": { $type: "string" } } }, { $group: { _id: "$answers.openingSlug", count: { $sum: 1 } } }]),
    ]);
    const bySlug = new Map(counts.map((entry) => [entry._id, entry.count]));
    return res.set("Cache-Control", "no-store").json({
      items: items.map((item) => ({ ...publicShape(item), id: String(item._id), status: item.status, createdAt: item.createdAt, applications: bySlug.get(item.slug) || 0 })),
      rules: RULES,
    });
  } catch (error) {
    return next(error);
  }
}

async function uniqueSlug(title, exceptId) {
  const base = slugify(title);
  for (let index = 1; index < 50; index += 1) {
    const slug = index === 1 ? base : `${base}-${index}`;
    const clash = await JobOpening.exists({ slug, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
    if (!clash) return slug;
  }
  invalid("Choose a more specific job title.");
  return "";
}

export async function createOpening(req, res, next) {
  try {
    const input = validateOpening({ ...req.body, updatedAt: undefined });
    const item = await JobOpening.create({ ...input, slug: await uniqueSlug(input.title), postedAt: input.status === "open" ? new Date() : null, createdBy: req.admin.id, updatedBy: req.admin.id });
    return res.status(201).json({ item: { ...publicShape(item.toObject()), id: String(item._id), status: item.status } });
  } catch (error) {
    return respond(res, error, next);
  }
}

export async function updateOpening(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Role not found." });
    const current = await JobOpening.findById(req.params.id);
    if (!current) return res.status(404).json({ error: "Role not found." });
    if (String(req.body?.updatedAt || "") !== current.updatedAt.toISOString()) return res.status(409).json({ error: "Someone else changed this role after you opened it. Reload and try again." });
    const input = validateOpening({ ...req.body, updatedAt: undefined });
    // The link stays the same once a role has been published.
    const slug = current.postedAt ? current.slug : await uniqueSlug(input.title, current._id);
    Object.assign(current, input, { slug, updatedBy: req.admin.id });
    if (input.status === "open" && !current.postedAt) current.postedAt = new Date();
    await current.save();
    return res.json({ item: { ...publicShape(current.toObject()), id: String(current._id), status: current.status } });
  } catch (error) {
    return respond(res, error, next);
  }
}

export async function deleteOpening(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Role not found." });
    const current = await JobOpening.findById(req.params.id);
    if (!current) return res.status(404).json({ error: "Role not found." });
    if (current.status === "open") return res.status(400).json({ error: "Close the role before deleting it." });
    await current.deleteOne();
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
}
