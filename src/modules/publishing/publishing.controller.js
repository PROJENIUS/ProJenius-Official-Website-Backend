import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import ContentArticle from "./contentArticle.model.js";
import Course from "../courses/course.model.js";
import NewsletterSubscriber from "./newsletterSubscriber.model.js";
import NewsletterCampaign from "./newsletterCampaign.model.js";
import NewsletterDelivery from "./newsletterDelivery.model.js";
import AdminAuditEvent from "../admin/management/adminAudit.model.js";
import { articleBySlug, makeUnsubscribeToken, queuePublication, subscribeNewsletter, confirmNewsletter, unsubscribeNewsletter, suppressNewsletterSubscriber, serializePublicArticle } from "./publishing.service.js";
import { LEGACY_PUBLISHING_UPLOAD_ROOT, PUBLISHING_UPLOAD_ROOT } from "./publishing.storage.js";
import { findStoredImage, storeImage, streamStoredImage, storedImageExists } from "../../shared/media/gridfsMedia.service.js";

const uploadRoots = [PUBLISHING_UPLOAD_ROOT, LEGACY_PUBLISHING_UPLOAD_ROOT];
const validSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function fail(res, status, error) { return res.status(status).json({ error }); }
function missingPublicImage(res) { return res.status(404).type("text/plain").send("Article image not found."); }
async function uploadedImagePath(filename) {
  for (const root of uploadRoots) {
    const filepath = path.join(root, filename);
    const stat = await fs.lstat(filepath).catch(() => null);
    if (stat?.isFile() && !stat.isSymbolicLink()) return filepath;
  }
  return null;
}
async function uploadedImagesExist(images) {
  for (const image of images) {
    if (!/^[a-f\d-]{36}\.(png|jpe?g|webp)$/i.test(image.filename)) return false;
    if (image.mediaId) {
      if (!(await storedImageExists(image.mediaId, { mimeType: image.mimeType, size: image.size }))) return false;
      continue;
    }
    const filePath = await uploadedImagePath(image.filename);
    const stat = filePath ? await fs.lstat(filePath).catch(() => null) : null;
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== image.size) return false;
  }
  return true;
}
export function validateVideoUrl(raw, title = "") {
  if (typeof raw !== "string" || raw.length > 500) throw Object.assign(new Error("Video URL is invalid."), { status: 400 });
  let url; try { url = new URL(raw); } catch { throw Object.assign(new Error("Video URL is invalid."), { status: 400 }); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) throw Object.assign(new Error("Use a secure YouTube or Vimeo video URL."), { status: 400 });
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let provider, videoId;
  if (["youtube.com", "youtube-nocookie.com"].includes(host)) {
    provider = "youtube"; videoId = url.pathname === "/watch" ? url.searchParams.get("v") : url.pathname.match(/^\/(?:embed|shorts)\/([A-Za-z0-9_-]{6,20})\/?$/)?.[1];
  } else if (host === "youtu.be") { provider = "youtube"; videoId = url.pathname.match(/^\/([A-Za-z0-9_-]{6,20})\/?$/)?.[1]; }
  else if (["vimeo.com", "player.vimeo.com"].includes(host)) { provider = "vimeo"; videoId = url.pathname.match(host === "player.vimeo.com" ? /^\/video\/(\d+)\/?$/ : /^\/(\d+)\/?$/)?.[1]; }
  if (!provider || !videoId || url.searchParams.has("v") && url.pathname !== "/watch") throw Object.assign(new Error("Use a valid YouTube or Vimeo video URL."), { status: 400 });
  return { provider, videoId, url: provider === "youtube" ? `https://www.youtube.com/watch?v=${videoId}` : `https://vimeo.com/${videoId}`, title: String(title).trim().slice(0, 180) };
}
export function validateArticle(body, { maxImages = 5 } = {}) {
  const allowed = ["contentType", "title", "slug", "summary", "body", "images", "videos", "thumbnailFilename", "category", "tags", "author", "seo", "status", "scheduledAt", "timezone"];
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) throw Object.assign(new Error("Article fields are invalid."), { status: 400 });
  const contentType = body.contentType;
  if (!(["news", "blog"].includes(contentType))) throw Object.assign(new Error("Content type is invalid."), { status: 400 });
  const title = String(body.title || "").trim(); const slug = String(body.slug || "").trim().toLowerCase(); const summary = String(body.summary || "").trim(); const textBody = String(body.body || "").trim();
  if (!title || title.length > 180 || !validSlug.test(slug) || slug.length > 190 || !summary || summary.length > 500 || !textBody || textBody.length > 50000) throw Object.assign(new Error("Title, slug, summary or article body is invalid."), { status: 400 });
  if (!Array.isArray(body.images || []) || (body.images || []).length > maxImages || !Array.isArray(body.videos || []) || (body.videos || []).length > 10 || !Array.isArray(body.tags || []) || (body.tags || []).length > 20) throw Object.assign(new Error("Image, video or tag list is invalid."), { status: 400 });
  const status = body.status || "draft";
  if (!["draft", "scheduled", "published", "unpublished", "archived"].includes(status)) throw Object.assign(new Error("Publication status is invalid."), { status: 400 });
  const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : null;
  if (status === "scheduled" && (!scheduledAt || Number.isNaN(+scheduledAt) || scheduledAt <= new Date())) throw Object.assign(new Error("Scheduled publication time must be in the future."), { status: 400 });
  const timezone = String(body.timezone || "Asia/Kolkata").trim();
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw Object.assign(new Error("A valid IANA timezone is required."), { status: 400 }); }
  const images = (body.images || []).map((image) => {
    if (image.mediaId && !mongoose.isValidObjectId(image.mediaId)) throw Object.assign(new Error("Article image media reference is invalid."), { status: 400 });
    return { mediaId: image.mediaId ? new mongoose.Types.ObjectId(image.mediaId) : null, filename: String(image.filename), originalFilename: String(image.originalFilename || "").slice(0, 255), mimeType: String(image.mimeType), size: Number(image.size), uploadedAt: image.uploadedAt ? new Date(image.uploadedAt) : null, alt: String(image.alt || "").slice(0, 180) };
  });
  const videos = (body.videos || []).map((video) => validateVideoUrl(video?.url, video?.title));
  if (new Set(videos.map((video) => video.url)).size !== videos.length) throw Object.assign(new Error("Video URLs must be unique."), { status: 400 });
  return { contentType, title, slug, summary, body: textBody, images, videos, thumbnailFilename: body.thumbnailFilename || null, category: String(body.category || "").trim().slice(0, 100), tags: (body.tags || []).map((tag) => String(tag).trim().slice(0, 40)).filter(Boolean), author: { name: String(body.author?.name || "").trim().slice(0, 120), role: String(body.author?.role || "").trim().slice(0, 120) }, seo: { title: String(body.seo?.title || "").trim().slice(0, 180), description: String(body.seo?.description || "").trim().slice(0, 320) }, status, scheduledAt: status === "scheduled" ? scheduledAt : null, timezone };
}

export async function subscribe(req, res, next) {
  try {
    if (typeof req.body?.email !== "string") return fail(res, 400, "Enter a valid email address.");
    if (req.body?.consent !== true) return fail(res, 400, "Please confirm your consent to receive newsletter emails.");
    const result = await subscribeNewsletter(req.body.email, true);
    if (result.status === "already_subscribed") return res.json({ status: result.status, message: "You're already subscribed to ProJenius updates! Stay tuned for our latest news and insights." });
    if (result.status === "subscribed" && result.welcomeEmailStatus === "sent") return res.status(202).json({ status: result.status, emailStatus: "sent", message: "Thanks for subscribing to ProJenius updates! Your welcome email has been sent." });
    if (result.status === "subscribed" && result.welcomeEmailStatus === "queued") return res.status(202).json({ status: result.status, emailStatus: "queued", message: "You're subscribed to ProJenius updates. We couldn't send your welcome email yet, so we'll retry." });
    if (result.status === "subscribed") return res.status(202).json({ status: result.status, emailStatus: "failed", message: "You're subscribed to ProJenius updates, but we couldn't send the welcome email. Please contact us if you need help." });
    return fail(res, 500, "We could not complete your subscription. Please try again.");
  } catch (e) { if (e.status) return fail(res, e.status, e.message); return next(e); }
}
export async function confirm(req, res, next) { try { const success = await confirmNewsletter(req.body?.token); return success ? res.json({ message: "Your subscription is confirmed." }) : fail(res, 400, "This confirmation link is invalid or expired."); } catch (e) { return next(e); } }
export async function unsubscribe(req, res, next) { try { const success = await unsubscribeNewsletter(req.body?.subscriberId || req.query.id, req.body?.token || req.query.token); return success ? res.json({ message: "You have been unsubscribed." }) : fail(res, 400, "This unsubscribe link is invalid."); } catch (e) { return next(e); } }
export async function publicList(req, res, next) { try { const type = req.params.type === "blog" ? "blog" : req.params.type === "news" ? "news" : null; if (!type) return fail(res, 404, "Content not found."); const page = Math.min(10000, Math.max(1, Number.parseInt(req.query.page, 10) || 1)); const limit = Math.min(30, Math.max(1, Number.parseInt(req.query.limit, 10) || 12)); const filter = { contentType: type, status: "published", publishedAt: { $lte: new Date() } }; if (typeof req.query.category === "string" && req.query.category) filter.category = req.query.category.slice(0, 100); if (typeof req.query.search === "string" && req.query.search.trim()) { const escaped = req.query.search.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); filter.$or = [{ title: new RegExp(escaped, "i") }, { summary: new RegExp(escaped, "i") }, { tags: new RegExp(escaped, "i") }]; } const [items, total] = await Promise.all([ContentArticle.find(filter).select("contentType title slug summary category author thumbnailFilename images.filename images.mediaId images.alt publishedAt seo").sort({ publishedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), ContentArticle.countDocuments(filter)]); res.set("Cache-Control", "public, max-age=60"); return res.json({ items: items.map(serializePublicArticle), pagination: { page, limit, total, pages: Math.ceil(total / limit) } }); } catch (e) { return next(e); } }
export async function publicUnifiedList(req, res, next) { try { const page = Math.min(10000, Math.max(1, Number.parseInt(req.query.page, 10) || 1)); const limit = Math.min(30, Math.max(1, Number.parseInt(req.query.limit, 10) || 12)); const filter = { status: "published", publishedAt: { $lte: new Date() } }; if (typeof req.query.category === "string" && req.query.category.trim()) filter.category = req.query.category.trim().slice(0, 100); if (typeof req.query.search === "string" && req.query.search.trim()) { const escaped = req.query.search.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); filter.$or = [{ title: new RegExp(escaped, "i") }, { summary: new RegExp(escaped, "i") }, { tags: new RegExp(escaped, "i") }]; } const [items, total] = await Promise.all([ContentArticle.find(filter).select("contentType title slug summary category author thumbnailFilename images.filename images.mediaId images.alt publishedAt seo").sort({ publishedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), ContentArticle.countDocuments(filter)]); res.set("Cache-Control", "public, max-age=60"); return res.json({ items: items.map(serializePublicArticle), pagination: { page, limit, total, pages: Math.ceil(total / limit) } }); } catch (e) { return next(e); } }
export async function publicCategories(_req, res, next) { try { const categories = await ContentArticle.distinct("category", { status: "published", publishedAt: { $lte: new Date() }, category: { $nin: ["", null] } }); return res.json({ items: categories.filter(Boolean).sort((a, b) => a.localeCompare(b)) }); } catch (e) { return next(e); } }
export async function publicDetail(req, res, next) { try { const type = req.params.type === "blog" ? "blog" : req.params.type === "news" ? "news" : null; const item = type ? await articleBySlug(type, req.params.slug) : null; if (!item) return fail(res, 404, "Article not found."); res.set("Cache-Control", "public, max-age=60"); return res.json({ item }); } catch (e) { return next(e); } }
export async function uploadImage(req, res, next) {
  try {
    const file = req.file;
    if (!file || !Buffer.isBuffer(file.buffer) || file.size > 5 * 1024 * 1024) return fail(res, 400, "Select an image up to 5 MB.");
    const types = [{ mime: "image/png", ext: "png", extensions: ["png"], check: () => file.buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) }, { mime: "image/jpeg", ext: "jpg", extensions: ["jpg", "jpeg"], check: () => file.buffer[0] === 255 && file.buffer[1] === 216 && file.buffer[2] === 255 }, { mime: "image/webp", ext: "webp", extensions: ["webp"], check: () => file.buffer.toString("ascii", 0, 4) === "RIFF" && file.buffer.toString("ascii", 8, 12) === "WEBP" }];
    const extension = path.extname(file.originalname).slice(1).toLowerCase();
    const match = types.find((type) => type.mime === file.mimetype && type.extensions.includes(extension) && type.check());
    if (!match) return fail(res, 400, "Only valid PNG, JPEG or WebP images are supported.");
    const filename = `${crypto.randomUUID()}.${match.ext}`;
    const stored = await storeImage({ buffer: file.buffer, filename, originalFilename: file.originalname, mimeType: match.mime });
    return res.status(201).json({ item: { mediaId: stored.mediaId, filename: stored.filename, originalFilename: stored.originalFilename, mimeType: stored.mimeType, size: stored.size, uploadedAt: stored.uploadedAt, url: `/api/media/${stored.mediaId}` } });
  } catch (e) { return next(e); }
}

export async function publicMedia(req, res, next) {
  try {
    const mediaId = req.params.mediaId;
    if (!/^[a-f\d]{24}$/i.test(mediaId)) return missingPublicImage(res);
    const now = new Date();
    const [articleReferenced, courseReferenced, campaignReferenced] = await Promise.all([
      ContentArticle.exists({ status: "published", publishedAt: { $lte: now }, $or: [{ "images.mediaId": mediaId }, { $and: [{ thumbnailFilename: { $ne: null } }, { "images.mediaId": mediaId }] }] }),
      Course.exists({ deliveryMode: { $in: ["online", "in-person", "hybrid"] }, status: "published", publishedAt: { $lte: now }, "coverImage.mediaId": mediaId }),
      NewsletterCampaign.exists({ imageMediaId: mediaId, status: { $in: ["queued", "processing", "sent", "failed"] } }),
    ]);
    if (!articleReferenced && !courseReferenced && !campaignReferenced) return missingPublicImage(res);
    if (!(await streamStoredImage(mediaId, res, { crossOriginResourcePolicy: "cross-origin" }))) return missingPublicImage(res);
  } catch (e) { return next(e); }
}
export async function publicAsset(req, res, next) { try { const filename = req.params.filename; if (!/^[a-f\d-]{36}\.(png|jpe?g|webp)$/i.test(filename)) return missingPublicImage(res); const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); const [publishedArticle, campaignReferenced] = await Promise.all([ContentArticle.exists({ status: "published", publishedAt: { $lte: new Date() }, $or: [{ thumbnailFilename: filename }, { "images.filename": filename }] }), NewsletterCampaign.exists({ imageSnapshot: { $regex: new RegExp(`/api/news/assets/${escapedFilename}(?:$|[?#])`, "i") } })]); if (!publishedArticle && !campaignReferenced) return missingPublicImage(res); const filepath = await uploadedImagePath(filename); if (!filepath) return missingPublicImage(res); res.set({ "Cache-Control": "public, max-age=300", "Cross-Origin-Resource-Policy": "cross-origin" }); return res.sendFile(filepath, (error) => { if (error && !res.headersSent) missingPublicImage(res); }); } catch (e) { return next(e); } }
export async function adminAsset(req, res, next) {
  try {
    const reference = req.params.filename;
    if (/^[a-f\d]{24}$/i.test(reference)) {
      const exists = await ContentArticle.exists({ "images.mediaId": reference });
      if (!exists) return res.sendStatus(404);
      if (!(await streamStoredImage(reference, res, { cacheControl: "private, no-store" }))) return res.sendStatus(404);
      return;
    }
    if (!/^[a-f\d-]{36}\.(png|jpe?g|webp)$/i.test(reference)) return res.sendStatus(404);
    const exists = await ContentArticle.exists({ $or: [{ thumbnailFilename: reference }, { "images.filename": reference }] });
    if (!exists) return res.sendStatus(404);
    const filepath = await uploadedImagePath(reference);
    if (!filepath) return res.sendStatus(404);
    res.set("Cache-Control", "private, no-store");
    return res.sendFile(filepath, (error) => { if (error && !res.headersSent) res.sendStatus(404); });
  } catch (e) { return next(e); }
}

export async function adminList(req, res, next) { try { const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1); const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20)); const filter = {}; if (["news", "blog"].includes(req.query.type)) filter.contentType = req.query.type; if (["draft", "scheduled", "published", "unpublished", "archived"].includes(req.query.status)) filter.status = req.query.status; if (typeof req.query.category === "string" && req.query.category.trim()) filter.category = req.query.category.trim().slice(0, 100); if (typeof req.query.search === "string" && req.query.search.trim()) { const value = req.query.search.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); filter.$or = [{ title: new RegExp(value, "i") }, { slug: new RegExp(value, "i") }]; } const [items, total] = await Promise.all([ContentArticle.find(filter).select("title slug contentType summary category author thumbnailFilename status scheduledAt timezone publishedAt announcementStatus createdAt updatedAt").sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), ContentArticle.countDocuments(filter)]); return res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } }); } catch (e) { return next(e); } }
export async function adminGet(req, res, next) { try { if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, "Article ID is invalid."); const item = await ContentArticle.findById(req.params.id).lean(); return item ? res.json({ item }) : fail(res, 404, "Article not found."); } catch (e) { return next(e); } }
export async function createArticle(req, res, next) { try { const input = validateArticle(req.body); const validNames = new Set(input.images.map((image) => image.filename)); if (input.images.some((image) => !["image/png", "image/jpeg", "image/webp"].includes(image.mimeType) || image.size < 1 || image.size > 5 * 1024 * 1024) || (input.thumbnailFilename && !validNames.has(input.thumbnailFilename)) || !(await uploadedImagesExist(input.images))) return fail(res, 400, "Article image data is invalid or unavailable."); const published = input.status === "published"; const item = await ContentArticle.create({ ...input, publishedAt: published ? new Date() : null, announcementStatus: published ? "pending" : "not_eligible", createdBy: req.admin.id, updatedBy: req.admin.id }); return res.status(201).json({ item }); } catch (e) { if (e.code === 11000) return fail(res, 409, "An article already uses that slug."); if (e.status) return fail(res, e.status, e.message); return next(e); } }
export async function updateArticle(req, res, next) { try { if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, "Article ID is invalid."); const item = await ContentArticle.findById(req.params.id); if (!item) return fail(res, 404, "Article not found."); const existingImageNames = new Set(item.images.map((image) => image.filename)); const input = validateArticle({ ...req.body, contentType: item.contentType, status: item.status, scheduledAt: req.body?.scheduledAt || item.scheduledAt, timezone: req.body?.timezone || item.timezone }, { maxImages: Math.max(5, item.images.length) }); if (input.status !== item.status) return fail(res, 400, "Use the publication action to change article status."); if (input.images.length > 5 && input.images.some((image) => !existingImageNames.has(image.filename))) return fail(res, 400, "Reduce this legacy gallery to five images before adding more."); const validNames = new Set(input.images.map((image) => image.filename)); if ((input.thumbnailFilename && !validNames.has(input.thumbnailFilename)) || !(await uploadedImagesExist(input.images))) return fail(res, 400, "Choose images already uploaded to this site."); Object.assign(item, input, { updatedBy: req.admin.id }); await item.save(); return res.json({ item }); } catch (e) { if (e.code === 11000) return fail(res, 409, "An article already uses that slug."); if (e.status) return fail(res, e.status, e.message); return next(e); } }
export async function publishNow(req, res, next) { try { if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, "Article ID is invalid."); const item = await ContentArticle.findById(req.params.id); if (!item) return fail(res, 404, "Article not found."); const wasPublished = item.status === "published" && item.publishedAt; item.status = "published"; item.scheduledAt = null; item.publishedAt ||= new Date(); item.updatedBy = req.admin.id; if (!wasPublished) item.announcementStatus = "pending"; await item.save(); return res.json({ item }); } catch (e) { return next(e); } }
export async function changeArticleState(req, res, next) { try { if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, "Article ID is invalid."); const item = await ContentArticle.findById(req.params.id); if (!item) return fail(res, 404, "Article not found."); const action = req.body?.action; if (action === "schedule") { const date = new Date(req.body?.scheduledAt); const timezone = String(req.body?.timezone || "").trim(); if (!req.body?.scheduledAt || Number.isNaN(+date) || date <= new Date()) return fail(res, 400, "Choose a future publication time."); try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { return fail(res, 400, "A valid IANA timezone is required."); } item.status = "scheduled"; item.scheduledAt = date; item.timezone = timezone; item.announcementStatus = "not_eligible"; } else if (action === "unpublish") { item.status = "unpublished"; item.scheduledAt = null; item.announcementStatus = "not_eligible"; } else if (action === "archive") { item.status = "archived"; item.scheduledAt = null; item.announcementStatus = "not_eligible"; } else return fail(res, 400, "Article action is invalid."); item.updatedBy = req.admin.id; await item.save(); return res.json({ item }); } catch (e) { return next(e); } }
export async function announceAgain(req, res, next) { try { if (!mongoose.isValidObjectId(req.params.id) || req.body?.confirm !== true) return fail(res, 400, "Explicit campaign confirmation is required."); const requestKey = req.get("Idempotency-Key"); if (typeof requestKey !== "string" || !/^[a-f\d-]{36}$/i.test(requestKey)) return fail(res, 400, "A valid campaign request key is required."); const source = await ContentArticle.findById(req.params.id); if (!source || source.status !== "published" || source.publishedAt > new Date()) return fail(res, 409, "Only published articles can be announced."); const key = `manual:${source.contentType}:${source._id}:${req.admin.id}:${requestKey}`; const campaign = await queuePublication({ type: source.contentType, source, eventType: "manual_announcement", initiatedBy: req.admin.id, uniqueKey: key }); return res.status(202).json({ item: { id: campaign?._id, status: campaign?.status } }); } catch (e) { return next(e); } }

export async function adminStats(_req, res, next) { try { const counts = await NewsletterSubscriber.aggregate([{ $match: { status: { $in: ["active", "unsubscribed"] } } }, { $group: { _id: "$status", count: { $sum: 1 } } }]); const legacyPending = await NewsletterSubscriber.countDocuments({ status: "pending" }); return res.json({ counts: { active: 0, unsubscribed: 0, ...Object.fromEntries(counts.map((x) => [x._id, x.count])) }, legacyPending }); } catch (e) { return next(e); } }
export async function adminSubscribers(req, res, next) { try { const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1); const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20)); const legacyPending = req.query.legacyPending === "true"; const status = req.query.status; if (!legacyPending && status && !["active", "unsubscribed"].includes(status)) return fail(res, 400, "Choose Active or Unsubscribed status."); const filter = legacyPending ? { status: "pending" } : { status: status ? status : { $in: ["active", "unsubscribed"] } }; const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : ""; if (search) filter.email = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" }; const [items, total] = await Promise.all([NewsletterSubscriber.find(filter).select("email status subscribedAt unsubscribedAt consent.acceptedAt createdAt").sort({ subscribedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), NewsletterSubscriber.countDocuments(filter)]); return res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } }); } catch (e) { return next(e); } }
export async function adminRemoveSubscriber(req, res, next) { try { if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, "Subscriber ID is invalid."); const result = await suppressNewsletterSubscriber(req.params.id); if (!result) return fail(res, 404, "Subscriber not found."); if (result.changed) await AdminAuditEvent.create({ actorId: req.admin.id, targetAdminId: null, action: "newsletter.subscriber.removed", metadata: { subscriberId: String(req.params.id), email: result.subscriber.email, suppressedDeliveryCount: result.suppressedCount } }); return res.json({ item: { id: String(req.params.id), status: "unsubscribed", changed: result.changed, suppressedDeliveryCount: result.suppressedCount }, message: result.changed ? "Subscriber removed from future newsletter campaigns." : "Subscriber was already unsubscribed." }); } catch (e) { return next(e); } }
export async function adminCampaigns(req, res, next) { try { const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1); const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20)); const [items, total] = await Promise.all([NewsletterCampaign.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select("-lastError").populate("eventId", "eventType contentType createdAt").lean(), NewsletterCampaign.countDocuments()]); return res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } }); } catch (e) { return next(e); } }
export async function adminDeliveries(req, res, next) { try { if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, "Campaign ID is invalid."); const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1); const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20)); const [items, total] = await Promise.all([NewsletterDelivery.find({ campaignId: req.params.id }).populate("subscriberId", "email status").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select("campaignId subscriberId status attempts acceptedAt failureCode lastAttemptAt").lean(), NewsletterDelivery.countDocuments({ campaignId: req.params.id })]); return res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } }); } catch (e) { return next(e); } }
export async function retryCampaign(req, res, next) { try { if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, "Campaign ID is invalid."); const campaign = await NewsletterCampaign.findById(req.params.id); if (!campaign || campaign.status === "cancelled") return fail(res, 404, "Retryable campaign not found."); const retried = await NewsletterDelivery.updateMany({ campaignId: campaign._id, status: "failed", attempts: { $lt: 5 } }, { $set: { status: "queued", nextAttemptAt: new Date(), leaseUntil: null, lastError: "" } }); if (!retried.modifiedCount) return fail(res, 409, "This campaign has no eligible failed deliveries to retry."); campaign.status = "queued"; campaign.nextAttemptAt = new Date(); campaign.leaseUntil = null; campaign.completedAt = null; await campaign.save(); return res.status(202).json({ item: { id: campaign._id, status: campaign.status } }); } catch (e) { return next(e); } }
export async function cancelCampaign(req, res, next) { try { if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 400, "Campaign ID is invalid."); const campaign = await NewsletterCampaign.findOneAndUpdate({ _id: req.params.id, status: "queued" }, { $set: { status: "cancelled", leaseUntil: null, completedAt: new Date() } }, { new: true }); if (!campaign) return fail(res, 409, "Only queued campaigns can be cancelled."); await NewsletterDelivery.updateMany({ campaignId: campaign._id, status: { $in: ["queued", "processing"] } }, { $set: { status: "suppressed", leaseUntil: null, failureCode: "campaign_cancelled" } }); return res.json({ item: { id: campaign._id, status: campaign.status } }); } catch (e) { return next(e); } }
