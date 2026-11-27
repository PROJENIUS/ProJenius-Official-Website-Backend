/* =========================================================
   PAGE HEROES — CONTROLLER
   Public:  GET    /api/page-heroes/:key             saved content or null
   Admin:   GET    /api/page-heroes/admin            pages and their status
            GET    /api/page-heroes/admin/:key       schema + saved values
            PUT    /api/page-heroes/admin/:key       save (needs revision)
            DELETE /api/page-heroes/admin/:key       back to website default
            POST   /api/page-heroes/admin/:key/image?field=…  upload (WebP)
            GET    /api/page-heroes/admin/media/:id  preview a saved image
========================================================= */

import crypto from "node:crypto";
import mongoose from "mongoose";
import PageHero from "./pageHero.model.js";
import { PAGE_HERO_IMAGE_RULES, PAGE_HERO_SCHEMAS, pageHeroSchema } from "./pageHero.schemas.js";
import { HERO_RULES } from "../homepage/homeHero.rules.js";
import { getHeroLinks } from "../homepage/siteLinks.service.js";
import { inspectUploadedImage } from "../../shared/media/uploadedImage.js";
import { imageDimensions } from "../../shared/media/imageDimensions.js";
import { findStoredImage, readStoredImage, storeImage, streamStoredImage } from "../../shared/media/gridfsMedia.service.js";

const LINK = new RegExp(HERO_RULES.linkPattern, "i");
const CTA_LABEL = { min: 2, max: 26 };

class InputError extends Error {}
const invalid = (message) => { throw new InputError(message); };
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function cleanText(value, { label, min = 0, max }, where) {
  if (typeof value !== "string") invalid(`${where}: ${label} is missing.`);
  // eslint-disable-next-line no-control-regex
  const textValue = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (textValue.length < min || textValue.length > max) invalid(`${where}: ${label} must be ${min}–${max} characters (now ${textValue.length}).`);
  return textValue;
}

function checkImageSize(width, height, spec, where) {
  const ratio = width / height;
  if (width < spec.minWidth || height < spec.minHeight) return `${where}: the image is ${width} × ${height} px; it must be at least ${spec.minWidth} × ${spec.minHeight} px. Best: ${spec.recommended}.`;
  if (ratio < spec.minRatio || ratio > spec.maxRatio) return `${where}: the image shape (${ratio.toFixed(2)}:1) does not fit this spot. Best: ${spec.recommended}.`;
  return "";
}

/* Walks the schema; returns clean values and the uploads to verify. */
function cleanValues(fields, values, where, uploads) {
  if (!isObject(values)) invalid(`${where} is invalid.`);
  const names = new Set(fields.map((field) => field.name));
  const unknown = Object.keys(values).find((name) => !names.has(name));
  if (unknown) invalid(`${where}: “${unknown}” is not a field of this hero.`);
  const out = {};
  for (const field of fields) {
    const value = values[field.name];
    const at = `${where} · ${field.label}`;
    if (field.type === "text") out[field.name] = cleanText(value, field, where);
    else if (field.type === "phrases") {
      if (!Array.isArray(value) || value.length < field.count.min || value.length > field.count.max) invalid(`${at}: give ${field.count.min === field.count.max ? field.count.min : `${field.count.min}–${field.count.max}`} items.`);
      out[field.name] = value.map((item, index) => cleanText(item, { label: `item ${index + 1}`, min: 2, max: field.max }, at));
    } else if (field.type === "cta") {
      if (!isObject(value) || Object.keys(value).some((name) => !["label", "to"].includes(name))) invalid(`${at} is invalid.`);
      const label = cleanText(value.label, { label: "button text", ...CTA_LABEL }, at);
      const to = typeof value.to === "string" ? value.to.trim() : "";
      if (!to || to.length > HERO_RULES.linkMax || !LINK.test(to)) invalid(`${at}: the link must be a page on this website.`);
      out[field.name] = { label, to };
    } else if (field.type === "image") {
      if (isObject(value) && value.source === "default" && Object.keys(value).length === 1) out[field.name] = { source: "default" };
      else if (isObject(value) && value.source === "upload" && Object.keys(value).every((name) => ["source", "mediaId"].includes(name)) && /^[a-f\d]{24}$/i.test(String(value.mediaId || ""))) {
        const entry = { source: "upload", mediaId: String(value.mediaId).toLowerCase() };
        uploads.push({ entry, spec: field, where: at });
        out[field.name] = entry;
      } else invalid(`${at}: upload the image again.`);
    } else if (field.type === "list") {
      if (!Array.isArray(value) || value.length < field.count.min || value.length > field.count.max) invalid(`${at}: give ${field.count.min} items.`);
      out[field.name] = value.map((item, index) => cleanValues(field.item, item, `${at} ${index + 1}`, uploads));
    }
  }
  return out;
}

export function validatePageHero(key, body) {
  const schema = pageHeroSchema(key);
  if (!schema) invalid("This page has no editable hero.");
  if (!isObject(body) || Object.keys(body).some((name) => !["values", "revision"].includes(name))) invalid("Hero content is invalid.");
  if (!Number.isInteger(body.revision) || body.revision < 0) invalid("Reload the editor and try again.");
  const uploads = [];
  const values = cleanValues(schema.fields, body.values, schema.label, uploads);
  return { schema, revision: body.revision, values, uploads };
}

function savedImages(values, list = []) {
  for (const value of Object.values(values || {})) {
    if (isObject(value) && value.source === "upload" && value.mediaId) list.push(value);
    else if (Array.isArray(value)) value.forEach((item) => isObject(item) && savedImages(item, list));
  }
  return list;
}

/* Image size and type come from the stored file, never from the request. */
async function resolveUploads(uploads, current) {
  const known = new Map(savedImages(current?.values).map((image) => [String(image.mediaId), image]));
  for (const { entry, spec, where } of uploads) {
    let details = known.get(entry.mediaId);
    if (!details?.width) {
      const stored = await readStoredImage(entry.mediaId);
      const size = stored && imageDimensions(stored.buffer, stored.file.metadata.mimeType);
      if (!stored || !size) invalid(`${where}: the uploaded image is missing. Upload it again.`);
      details = { mimeType: stored.file.metadata.mimeType, size: stored.file.length, width: size.width, height: size.height };
    }
    if (!PAGE_HERO_IMAGE_RULES.formats.includes(details.mimeType)) invalid(`${where}: use a WebP image.`);
    const problem = checkImageSize(details.width, details.height, spec, where);
    if (problem) invalid(problem);
    Object.assign(entry, { mimeType: details.mimeType, size: details.size, width: details.width, height: details.height });
  }
}

function toPublic(values) {
  const out = {};
  for (const [name, value] of Object.entries(values || {})) {
    if (isObject(value) && value.source === "upload") out[name] = { url: `/api/media/${value.mediaId}`, width: value.width, height: value.height };
    else if (isObject(value) && value.source === "default") out[name] = { source: "default" };
    else if (Array.isArray(value)) out[name] = value.map((item) => (isObject(item) ? toPublic(item) : item));
    else out[name] = value;
  }
  return out;
}

function toAdmin(values) {
  const out = {};
  for (const [name, value] of Object.entries(values || {})) {
    if (isObject(value) && value.source === "upload") out[name] = { source: "upload", mediaId: String(value.mediaId), width: value.width, height: value.height, size: value.size };
    else if (Array.isArray(value)) out[name] = value.map((item) => (isObject(item) ? toAdmin(item) : item));
    else out[name] = value;
  }
  return out;
}

async function adminPayload(schema, document) {
  const siteLinks = await getHeroLinks();
  return {
    schema,
    item: document ? { values: toAdmin(document.values), revision: document.revision, updatedAt: document.updatedAt } : { values: null, revision: 0, updatedAt: null },
    links: siteLinks.links,
    linksSource: siteLinks.source,
    imageRules: PAGE_HERO_IMAGE_RULES,
    ctaLabel: CTA_LABEL,
  };
}

const respond400 = (res, error, next) => {
  if (error instanceof InputError) return res.status(400).json({ error: error.message });
  if (error instanceof mongoose.Error.ValidationError) return res.status(400).json({ error: "Hero content is invalid." });
  return next(error);
};

export async function getPublicPageHero(req, res, next) {
  try {
    if (!pageHeroSchema(req.params.key)) return res.status(404).json({ error: "Page hero not found." });
    const document = await PageHero.findOne({ key: req.params.key }).lean();
    res.set("Cache-Control", "public, max-age=60");
    return res.json({ item: document ? { revision: document.revision, values: toPublic(document.values) } : null });
  } catch (error) {
    return next(error);
  }
}

export async function listAdminPageHeroes(_req, res, next) {
  try {
    const saved = new Map((await PageHero.find({}, { key: 1, revision: 1, updatedAt: 1 }).lean()).map((doc) => [doc.key, doc]));
    return res.set("Cache-Control", "no-store").json({
      items: PAGE_HERO_SCHEMAS.map(({ key, label, path }) => ({ key, label, path, revision: saved.get(key)?.revision || 0, updatedAt: saved.get(key)?.updatedAt || null })),
    });
  } catch (error) {
    return next(error);
  }
}

export async function getAdminPageHero(req, res, next) {
  try {
    const schema = pageHeroSchema(req.params.key);
    if (!schema) return res.status(404).json({ error: "This page has no editable hero." });
    const document = await PageHero.findOne({ key: schema.key }).lean();
    return res.set("Cache-Control", "no-store").json(await adminPayload(schema, document));
  } catch (error) {
    return next(error);
  }
}

export async function saveAdminPageHero(req, res, next) {
  try {
    const { schema, revision, values, uploads } = validatePageHero(req.params.key, req.body);
    const current = await PageHero.findOne({ key: schema.key }).lean();
    const currentRevision = current?.revision || 0;
    if (revision !== currentRevision) return res.status(409).json({ error: "Someone else saved this hero after you opened it. Reload to see their changes, then make yours again." });
    await resolveUploads(uploads, current);
    const mediaIds = [...new Set(uploads.map((upload) => upload.entry.mediaId))].map((id) => new mongoose.Types.ObjectId(id));

    let saved;
    if (!current) {
      try {
        saved = await PageHero.create({ key: schema.key, values, mediaIds, revision: 1, createdBy: req.admin.id, updatedBy: req.admin.id });
      } catch (error) {
        if (error?.code === 11000) return res.status(409).json({ error: "Someone else saved this hero at the same time. Reload and try again." });
        throw error;
      }
    } else {
      saved = await PageHero.findOneAndUpdate(
        { key: schema.key, revision: currentRevision },
        { $set: { values, mediaIds, updatedBy: req.admin.id }, $inc: { revision: 1 } },
        { new: true, runValidators: true },
      );
      if (!saved) return res.status(409).json({ error: "Someone else saved this hero at the same time. Reload and try again." });
    }
    return res.set("Cache-Control", "no-store").json(await adminPayload(schema, saved.toObject()));
  } catch (error) {
    return respond400(res, error, next);
  }
}

export async function resetAdminPageHero(req, res, next) {
  try {
    const schema = pageHeroSchema(req.params.key);
    if (!schema) return res.status(404).json({ error: "This page has no editable hero." });
    const revision = Number(req.body?.revision);
    const removed = await PageHero.findOneAndDelete({ key: schema.key, revision });
    if (!removed) return res.status(409).json({ error: "This hero changed since you opened it. Reload and try again." });
    return res.set("Cache-Control", "no-store").json(await adminPayload(schema, null));
  } catch (error) {
    return next(error);
  }
}

/* ?field=photo or ?field=cards.image picks the size rules for that spot. */
function imageSpec(schema, path) {
  const [name, child] = String(path || "").split(".");
  const field = schema.fields.find((entry) => entry.name === name);
  const spec = child ? field?.type === "list" && field.item.find((entry) => entry.name === child) : field;
  return spec?.type === "image" ? spec : null;
}

export async function uploadPageHeroImage(req, res, next) {
  try {
    const schema = pageHeroSchema(req.params.key);
    const spec = schema && imageSpec(schema, req.query.field);
    if (!spec) return res.status(400).json({ error: "Choose which image this is." });
    const checked = inspectUploadedImage(req.file);
    if (checked.error) return res.status(400).json({ error: checked.error });
    if (!PAGE_HERO_IMAGE_RULES.formats.includes(checked.mime)) return res.status(400).json({ error: "Upload a WebP image (.webp). Convert JPEG or PNG photos to WebP first, for example at squoosh.app." });
    const problem = checkImageSize(checked.width, checked.height, spec, "This spot");
    if (problem) return res.status(400).json({ error: problem.replace("This spot: the", "This") });
    const stored = await storeImage({ buffer: req.file.buffer, filename: `${crypto.randomUUID()}.${checked.ext}`, originalFilename: req.file.originalname, mimeType: checked.mime });
    return res.status(201).json({ item: { mediaId: stored.mediaId, mimeType: stored.mimeType, size: stored.size, width: checked.width, height: checked.height } });
  } catch (error) {
    return next(error);
  }
}

export async function adminPageHeroMedia(req, res, next) {
  try {
    const { mediaId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(mediaId)) return res.sendStatus(404);
    if (!(await PageHero.exists({ mediaIds: mediaId })) || !(await findStoredImage(mediaId))) return res.sendStatus(404);
    if (!(await streamStoredImage(mediaId, res, { cacheControl: "private, no-store" }))) return res.sendStatus(404);
  } catch (error) {
    return next(error);
  }
}

/** True when a saved page hero shows this image (public access). */
export function isPublicPageHeroMedia(mediaId) {
  return PageHero.exists({ mediaIds: mediaId });
}
