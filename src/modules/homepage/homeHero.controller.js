/* =========================================================
   HOME HERO — CONTROLLER
   Public:  GET  /api/home/hero                  visible slides
   Admin:   GET  /api/home/admin/hero            slides + rules
            PUT  /api/home/admin/hero            save all slides
            POST /api/home/admin/hero/image      upload one image
            GET  /api/home/admin/hero/media/:id  preview a saved image
   Saving replaces the whole slide list at once and needs the
   revision the editor loaded, so two people editing at the
   same time cannot silently overwrite each other.
========================================================= */

import crypto from "node:crypto";
import mongoose from "mongoose";
import HomeHero from "./homeHero.model.js";
import { HOME_HERO_DEFAULT_SLIDES } from "./homeHero.defaults.js";
import { BUILTIN_HERO_IMAGES, HERO_RULES } from "./homeHero.rules.js";
import { getHeroLinks } from "./siteLinks.service.js";
import { inspectUploadedImage } from "../../shared/media/uploadedImage.js";
import { imageDimensions } from "../../shared/media/imageDimensions.js";
import { findStoredImage, readStoredImage, storeImage, streamStoredImage } from "../../shared/media/gridfsMedia.service.js";

const HERO_KEY = "home-hero";
const SLIDE_KEYS = ["key", "isVisible", "caption", "eyebrow", "title", "highlight", "description", "image", "alt", "primary", "secondary"];
const TEXT_FIELDS = ["caption", "eyebrow", "title", "highlight", "description", "alt"];
const LINK = new RegExp(HERO_RULES.linkPattern, "i");

class HeroInputError extends Error {}
const invalid = (message) => { throw new HeroInputError(message); };
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/* One line of plain text: trimmed, inner whitespace collapsed, no control
   characters. React escapes it on the website, so no HTML can run. */
function cleanText(value, rule, where) {
  if (typeof value !== "string") invalid(`${where}: ${rule.label} is required.`);
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < rule.min || text.length > rule.max) invalid(`${where}: ${rule.label} must be ${rule.min}–${rule.max} characters (now ${text.length}).`);
  return text;
}

function cleanCta(value, where) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !["label", "to"].includes(key))) invalid(`${where} is invalid.`);
  const label = cleanText(value.label, HERO_RULES.text.ctaLabel, where);
  const to = typeof value.to === "string" ? value.to.trim() : "";
  if (!to || to.length > HERO_RULES.linkMax || !LINK.test(to)) invalid(`${where}: the link must be a page on this website, such as /services/courses or #home-services.`);
  return { label, to };
}

function checkImageSize(width, height, where = "") {
  const { minWidth, minHeight, minRatio, maxRatio } = HERO_RULES.image;
  const ratio = width / height;
  const prefix = where ? `${where}: the` : "This";
  if (width < minWidth || height < minHeight) return `${prefix} image is ${width} × ${height} px; it must be at least ${minWidth} × ${minHeight} px.`;
  if (ratio < minRatio || ratio > maxRatio) return `${prefix} image shape is ${ratio.toFixed(2)}:1; use a landscape image between 3:2 and 16:9 (16:10 is best).`;
  return "";
}

/** Validates the whole save request. Image files are checked afterwards. */
export function validateHeroInput(body) {
  if (!isPlainObject(body) || Object.keys(body).some((key) => !["slides", "revision"].includes(key))) invalid("Home Hero content is invalid.");
  if (!Number.isInteger(body.revision) || body.revision < 0) invalid("Reload the editor and try again.");
  const { min, max } = HERO_RULES.slides;
  if (!Array.isArray(body.slides) || body.slides.length < 1 || body.slides.length > max) invalid(`Keep between ${min} and ${max} slides.`);

  const keys = new Set();
  const slides = body.slides.map((slide, index) => {
    const where = `Slide ${index + 1}`;
    if (!isPlainObject(slide) || Object.keys(slide).some((key) => !SLIDE_KEYS.includes(key))) invalid(`${where} contains unsupported fields.`);
    const key = typeof slide.key === "string" ? slide.key : "";
    if (!/^[a-z0-9-]{1,40}$/.test(key) || keys.has(key)) invalid(`${where} has an invalid or repeated id.`);
    keys.add(key);
    if (typeof slide.isVisible !== "boolean") invalid(`${where}: choose whether it is shown.`);

    const out = { key, isVisible: slide.isVisible };
    for (const field of TEXT_FIELDS) out[field] = cleanText(slide[field], HERO_RULES.text[field], where);

    const image = slide.image;
    if (!isPlainObject(image)) invalid(`${where}: choose an image.`);
    if (image.source === "builtin" && Object.keys(image).every((name) => ["source", "builtinKey"].includes(name)) && BUILTIN_HERO_IMAGES.includes(image.builtinKey)) {
      out.image = { source: "builtin", builtinKey: image.builtinKey, mediaId: null, mimeType: null, size: null, width: null, height: null };
    } else if (image.source === "upload" && Object.keys(image).every((name) => ["source", "mediaId"].includes(name)) && /^[a-f\d]{24}$/i.test(String(image.mediaId || ""))) {
      out.image = { source: "upload", mediaId: String(image.mediaId).toLowerCase() };
    } else {
      invalid(`${where}: the image is invalid. Upload it again.`);
    }

    out.primary = cleanCta(slide.primary, `${where} main button`);
    out.secondary = cleanCta(slide.secondary, `${where} second button`);
    return out;
  });

  if (slides.filter((slide) => slide.isVisible).length < min) invalid(`Show at least ${min} slides; the thumbnail strip always shows three.`);
  return { revision: body.revision, slides };
}

/* Fills in type, size and pixel dimensions for uploaded images from the
   stored file itself, never from the request. */
async function resolveUploadedImages(slides, current) {
  const known = new Map((current?.slides || [])
    .filter((slide) => slide.image?.source === "upload" && slide.image.mediaId)
    .map((slide) => [String(slide.image.mediaId), slide.image]));

  for (const [index, slide] of slides.entries()) {
    if (slide.image.source !== "upload") continue;
    const where = `Slide ${index + 1}`;
    const previous = known.get(slide.image.mediaId);
    let details = previous && previous.width && previous.height
      ? { mimeType: previous.mimeType, size: previous.size, width: previous.width, height: previous.height }
      : null;
    if (!details) {
      const stored = await readStoredImage(slide.image.mediaId);
      const size = stored && imageDimensions(stored.buffer, stored.file.metadata.mimeType);
      if (!stored || !size) invalid(`${where}: the uploaded image is missing. Upload it again.`);
      details = { mimeType: stored.file.metadata.mimeType, size: stored.file.length, width: size.width, height: size.height };
    }
    const problem = checkImageSize(details.width, details.height, where);
    if (problem) invalid(problem);
    slide.image = { source: "upload", builtinKey: null, mediaId: new mongoose.Types.ObjectId(slide.image.mediaId), ...details };
  }
  return slides;
}

function adminSlide(slide) {
  const image = slide.image.source === "upload"
    ? { source: "upload", mediaId: String(slide.image.mediaId), width: slide.image.width, height: slide.image.height, size: slide.image.size }
    : { source: "builtin", builtinKey: slide.image.builtinKey };
  return { ...slide, image };
}

function publicSlide(slide) {
  const image = slide.image.source === "upload"
    ? { url: `/api/media/${slide.image.mediaId}`, width: slide.image.width, height: slide.image.height }
    : { builtinKey: slide.image.builtinKey };
  return {
    key: slide.key,
    caption: slide.caption,
    eyebrow: slide.eyebrow,
    title: slide.title,
    highlight: slide.highlight,
    description: slide.description,
    alt: slide.alt,
    image,
    primary: slide.primary,
    secondary: slide.secondary,
  };
}

function adminPayload(document, siteLinks) {
  return {
    item: document
      ? { slides: document.slides.map(adminSlide), revision: document.revision, updatedAt: document.updatedAt, isDefault: false }
      : { slides: HOME_HERO_DEFAULT_SLIDES.map((slide) => structuredClone(slide)), revision: 0, updatedAt: null, isDefault: true },
    rules: HERO_RULES,
    links: siteLinks.links,
    linksSource: siteLinks.source,
  };
}

export async function getPublicHero(_req, res, next) {
  try {
    const document = await HomeHero.findOne({ key: HERO_KEY }).lean();
    const slides = (document?.slides || []).filter((slide) => slide.isVisible);
    res.set("Cache-Control", "public, max-age=60");
    // Fewer than three visible slides cannot happen through the editor; the
    // website then keeps its built-in slides.
    if (slides.length < HERO_RULES.slides.min) return res.json({ item: null });
    return res.json({ item: { revision: document.revision, updatedAt: document.updatedAt, slides: slides.map(publicSlide) } });
  } catch (error) {
    return next(error);
  }
}

export async function getAdminHero(_req, res, next) {
  try {
    const [document, siteLinks] = await Promise.all([HomeHero.findOne({ key: HERO_KEY }).lean(), getHeroLinks()]);
    return res.set("Cache-Control", "no-store").json(adminPayload(document, siteLinks));
  } catch (error) {
    return next(error);
  }
}

export async function saveAdminHero(req, res, next) {
  try {
    const input = validateHeroInput(req.body);
    const current = await HomeHero.findOne({ key: HERO_KEY }).lean();
    const currentRevision = current?.revision || 0;
    if (input.revision !== currentRevision) {
      return res.status(409).json({ error: "Someone else saved the Home Hero after you opened it. Reload to see their changes, then make yours again." });
    }
    const slides = await resolveUploadedImages(input.slides, current);

    let saved;
    if (!current) {
      try {
        saved = await HomeHero.create({ key: HERO_KEY, slides, revision: 1, createdBy: req.admin.id, updatedBy: req.admin.id });
      } catch (error) {
        if (error?.code === 11000) return res.status(409).json({ error: "Someone else saved the Home Hero at the same time. Reload and try again." });
        throw error;
      }
    } else {
      saved = await HomeHero.findOneAndUpdate(
        { key: HERO_KEY, revision: currentRevision },
        { $set: { slides, updatedBy: req.admin.id }, $inc: { revision: 1 } },
        { new: true, runValidators: true },
      );
      if (!saved) return res.status(409).json({ error: "Someone else saved the Home Hero at the same time. Reload and try again." });
    }
    return res.set("Cache-Control", "no-store").json(adminPayload(saved.toObject(), await getHeroLinks()));
  } catch (error) {
    if (error instanceof HeroInputError) return res.status(400).json({ error: error.message });
    if (error instanceof mongoose.Error.ValidationError) return res.status(400).json({ error: "Home Hero content is invalid." });
    return next(error);
  }
}

export async function uploadHeroImage(req, res, next) {
  try {
    const checked = inspectUploadedImage(req.file);
    if (checked.error) return res.status(400).json({ error: checked.error });
    if (!HERO_RULES.image.formats.includes(checked.mime)) return res.status(400).json({ error: "Upload a WebP image (.webp). Convert JPEG or PNG photos to WebP first, for example at squoosh.app." });
    const problem = checkImageSize(checked.width, checked.height);
    if (problem) return res.status(400).json({ error: problem });
    const stored = await storeImage({ buffer: req.file.buffer, filename: `${crypto.randomUUID()}.${checked.ext}`, originalFilename: req.file.originalname, mimeType: checked.mime });
    return res.status(201).json({ item: { mediaId: stored.mediaId, mimeType: stored.mimeType, size: stored.size, width: checked.width, height: checked.height } });
  } catch (error) {
    return next(error);
  }
}

export async function adminHeroMedia(req, res, next) {
  try {
    const { mediaId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(mediaId)) return res.sendStatus(404);
    const referenced = await HomeHero.exists({ key: HERO_KEY, "slides.image.mediaId": mediaId });
    if (!referenced || !(await findStoredImage(mediaId))) return res.sendStatus(404);
    if (!(await streamStoredImage(mediaId, res, { cacheControl: "private, no-store" }))) return res.sendStatus(404);
  } catch (error) {
    return next(error);
  }
}

/** True when a visible Home Hero slide uses this image (public access). */
export function isPublicHeroMedia(mediaId) {
  return HomeHero.exists({ key: HERO_KEY, slides: { $elemMatch: { isVisible: true, "image.mediaId": mediaId } } });
}
