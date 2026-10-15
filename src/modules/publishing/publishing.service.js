import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import ContentArticle from "./contentArticle.model.js";
import NewsletterSubscriber from "./newsletterSubscriber.model.js";
import NewsletterCampaign from "./newsletterCampaign.model.js";
import NewsletterDelivery from "./newsletterDelivery.model.js";
import { PUBLISHING_UPLOAD_ROOT, LEGACY_PUBLISHING_UPLOAD_ROOT } from "./publishing.storage.js";
import PublicationEvent from "./publicationEvent.model.js";
import { sendNewsletterAnnouncementEmail, sendNewsletterWelcomeEmail } from "../../shared/email/email.service.js";
import { publicAssetUrl } from "../../shared/http/publicAssetUrl.js";
import { findStoredImage } from "../../shared/media/gridfsMedia.service.js";

const tokenHash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const plain = (value) => String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const origin = () => { try { const url = new URL(process.env.PUBLIC_SITE_ORIGIN || ""); if (!["https:", "http:"].includes(url.protocol) || (url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname))) return null; return url.origin; } catch { return null; } };
const apiOrigin = () => { try { const url = new URL(process.env.PUBLIC_API_ORIGIN || process.env.PUBLIC_SITE_ORIGIN || ""); if (!["https:", "http:"].includes(url.protocol) || (url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname))) return null; return url.origin; } catch { return null; } };
const newsUrl = (type, slug) => `${origin()}/news-insights/${type === "blog" ? "blog" : "news"}/${encodeURIComponent(slug)}`;
const id = (v) => String(v?._id || v);
const backoff = (attempt) => Math.min(6 * 60 * 60 * 1000, 30_000 * (2 ** Math.max(0, attempt - 1)));
const emailValid = (value) => typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const COURSE_IMAGE_ROOT = path.join(path.resolve(process.env.PRIVATE_UPLOAD_DIR || "./private_uploads"), "course_images");
const LEGACY_COURSE_IMAGE_ROOT = path.resolve(process.cwd(), "private_uploads", "course_images");
const validImageFilename = (filename) => /^[a-f\d-]{36}\.(?:png|jpe?g|webp)$/i.test(String(filename || ""));

async function campaignImageReference(type, source) {
  const articleImage = type === "course" ? source.coverImage : (source.images || []).find((image) => image.filename === source.thumbnailFilename);
  if (articleImage?.mediaId && await findStoredImage(articleImage.mediaId)) return `/api/media/${articleImage.mediaId}`;
  const filename = type === "course" ? source.coverImage?.filename : source.thumbnailFilename;
  if (!validImageFilename(filename)) return "";
  const roots = type === "course" ? [COURSE_IMAGE_ROOT, LEGACY_COURSE_IMAGE_ROOT] : [PUBLISHING_UPLOAD_ROOT, LEGACY_PUBLISHING_UPLOAD_ROOT];
  for (const root of roots) {
    const filePath = path.join(root, filename);
    const stat = await fs.lstat(filePath).catch(() => null);
    if (stat?.isFile() && !stat.isSymbolicLink()) return `/api/${type === "course" ? "courses" : "news"}/assets/${encodeURIComponent(filename)}`;
  }
  return "";
}

async function campaignImageUrl(campaign) {
  const configured = process.env.PUBLIC_API_ORIGIN?.trim();
  if (!configured) return "";
  let originUrl;
  try {
    originUrl = new URL(configured);
    const localTestOrigin = process.env.NODE_ENV !== "production" && originUrl.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(originUrl.hostname.toLowerCase());
    if (originUrl.username || originUrl.password || originUrl.search || originUrl.hash || (originUrl.protocol !== "https:" && !localTestOrigin)) return "";
  } catch { return ""; }
  if (campaign.imageMediaId) {
    const file = await findStoredImage(campaign.imageMediaId);
    return file ? `${originUrl.origin}/api/media/${campaign.imageMediaId}` : "";
  }
  const expectedPath = campaign.type === "course" ? /^\/api\/courses\/assets\/([a-f\d-]{36}\.(?:png|jpe?g|webp))$/i : /^\/api\/news\/assets\/([a-f\d-]{36}\.(?:png|jpe?g|webp))$/i;
  let imagePath;
  try {
    const parsed = new URL(campaign.imageSnapshot, originUrl.origin);
    if (parsed.search || parsed.hash || (parsed.protocol !== "https:" && !((process.env.NODE_ENV !== "production") && parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase())))) return "";
    const match = parsed.pathname.match(expectedPath);
    if (!match || !validImageFilename(match[1])) return "";
    imagePath = parsed.pathname;
  } catch { return ""; }
  const filename = imagePath.slice(imagePath.lastIndexOf("/") + 1);
  const roots = campaign.type === "course" ? [COURSE_IMAGE_ROOT, LEGACY_COURSE_IMAGE_ROOT] : [PUBLISHING_UPLOAD_ROOT, LEGACY_PUBLISHING_UPLOAD_ROOT];
  for (const root of roots) {
    const stat = await fs.lstat(path.join(root, filename)).catch(() => null);
    if (stat?.isFile() && !stat.isSymbolicLink()) return `${originUrl.origin}${imagePath}`;
  }
  return "";
}

export function makeUnsubscribeToken(subscriberId, version = 0) {
  const expiresAt = Date.now() + 5 * 365 * 24 * 60 * 60 * 1000;
  const secret = process.env.SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error("Newsletter token service is not configured.");
  const signature = crypto.createHmac("sha256", secret).update(`newsletter-unsubscribe:${subscriberId}:${version}:${expiresAt}`).digest("base64url");
  return `${expiresAt}.${version}.${signature}`;
}

export async function subscribeNewsletter(email, consentGiven = false) {
  if (consentGiven !== true) throw Object.assign(new Error("Newsletter consent is required."), { status: 400 });
  const normalized = String(email || "").trim().toLowerCase();
  if (!emailValid(normalized)) throw Object.assign(new Error("Enter a valid email address."), { status: 400 });
  const now = new Date();
  const consent = { source: "website-footer", acceptedAt: now, policyVersion: "newsletter-v1" };
  const eventId = crypto.randomUUID();
  const consentEvent = { eventId, ...consent };
  const initialWelcome = { welcomeEmailStatus: "queued", welcomeEmailAttempts: 0, welcomeEmailNextAttemptAt: now, welcomeEmailLeaseUntil: null, welcomeEmailQueuedAt: now, welcomeEmailSentAt: null, welcomeEmailLastError: "", welcomeEmailMessageId: "" };
  let subscriber = await NewsletterSubscriber.findOne({ email: normalized }).select("+confirmationTokenHash +confirmationTokenExpiresAt +confirmationLeaseUntil +lastConfirmationAttemptAt +confirmationAttemptCount +unsubscribeTokenVersion");
  let newlyCreated = false;

  if (subscriber?.status === "active") {
    if (!subscriber.consent?.acceptedAt) {
      await NewsletterSubscriber.updateOne({ _id: subscriber._id, status: "active", $or: [{ "consent.acceptedAt": null }, { "consent.acceptedAt": { $exists: false } }] }, { $set: { consent, confirmedAt: subscriber.confirmedAt || now }, $addToSet: { consentHistory: consentEvent } });
    }
    return { status: "already_subscribed" };
  }
  if (!subscriber) {
    try {
      subscriber = await NewsletterSubscriber.create({ email: normalized, status: "active", consent, consentHistory: [consentEvent], subscriptionEventId: eventId, subscribedAt: now, confirmedAt: now, ...initialWelcome });
      newlyCreated = true;
    } catch (error) {
      if (error.code !== 11000) throw error;
      subscriber = await NewsletterSubscriber.findOne({ email: normalized }).select("+confirmationTokenHash +confirmationTokenExpiresAt +confirmationLeaseUntil +lastConfirmationAttemptAt +confirmationAttemptCount +unsubscribeTokenVersion");
      if (subscriber?.status === "active") {
        if (!subscriber.consent?.acceptedAt) {
          await NewsletterSubscriber.updateOne({ _id: subscriber._id, status: "active", $or: [{ "consent.acceptedAt": null }, { "consent.acceptedAt": { $exists: false } }] }, { $set: { consent, confirmedAt: subscriber.confirmedAt || now }, $addToSet: { consentHistory: consentEvent } });
        }
        return { status: "already_subscribed" };
      }
    }
  }

  if (newlyCreated) {
    await processNewsletterWelcomeEmails(now, subscriber._id);
    const finalRecord = await NewsletterSubscriber.findById(subscriber._id).select("welcomeEmailStatus");
    return { status: "subscribed", welcomeEmailStatus: finalRecord?.welcomeEmailStatus || "queued" };
  }
  if (subscriber?.status !== "pending" && subscriber?.status !== "unsubscribed") return { status: "already_subscribed" };
  const history = [];
  if (subscriber.consent?.acceptedAt && !(subscriber.consentHistory || []).some((entry) => new Date(entry.acceptedAt).getTime() === new Date(subscriber.consent.acceptedAt).getTime())) {
    history.push({ eventId: subscriber.subscriptionEventId || "", ...(subscriber.consent.toObject?.() || subscriber.consent) });
  }
  history.push(consentEvent);
  const update = {
    $set: {
      status: "active", consent, subscriptionEventId: eventId, subscribedAt: now, confirmedAt: now,
      confirmationAttemptCount: 0, lastConfirmationAttemptAt: null, confirmationLeaseUntil: null,
      ...initialWelcome,
    },
    $unset: { confirmationTokenHash: 1, confirmationTokenExpiresAt: 1 },
    $addToSet: { consentHistory: { $each: history } },
    $inc: { unsubscribeTokenVersion: 1 },
  };
  if (subscriber.status === "unsubscribed" && subscriber.unsubscribedAt) {
    update.$addToSet.unsubscribeHistory = subscriber.unsubscribedAt;
  }
  const activated = await NewsletterSubscriber.findOneAndUpdate(
    { _id: subscriber._id, status: subscriber.status }, update, { new: true },
  );
  if (!activated) return { status: "already_subscribed" };

  await processNewsletterWelcomeEmails(now, activated._id);
  const finalRecord = await NewsletterSubscriber.findById(activated._id).select("welcomeEmailStatus");
  return { status: "subscribed", welcomeEmailStatus: finalRecord?.welcomeEmailStatus || "queued" };
}

export async function confirmNewsletter(token) {
  if (typeof token !== "string" || token.length < 32 || token.length > 200) return false;
  const now = new Date();
  const pending = await NewsletterSubscriber.findOne({ confirmationTokenHash: tokenHash(token), status: "pending", confirmationTokenExpiresAt: { $gt: now } });
  if (!pending) return false;
  const eventId = crypto.randomUUID();
  const consentEvent = pending.consent?.acceptedAt ? { eventId, source: pending.consent.source, acceptedAt: pending.consent.acceptedAt, policyVersion: pending.consent.policyVersion } : null;
  const update = { $set: { status: "active", subscriptionEventId: eventId, confirmedAt: now, welcomeEmailStatus: "queued", welcomeEmailAttempts: 0, welcomeEmailNextAttemptAt: now, welcomeEmailLeaseUntil: null, welcomeEmailQueuedAt: now, welcomeEmailSentAt: null, welcomeEmailLastError: "", welcomeEmailMessageId: "" }, $unset: { confirmationTokenHash: 1, confirmationTokenExpiresAt: 1, confirmationLeaseUntil: 1 } };
  if (consentEvent) update.$addToSet = { consentHistory: consentEvent };
  const subscriber = await NewsletterSubscriber.findOneAndUpdate({ _id: pending._id, confirmationTokenHash: tokenHash(token), status: "pending", confirmationTokenExpiresAt: { $gt: now } }, update, { new: true });
  if (!subscriber) return false;
  try { await processNewsletterWelcomeEmails(now, subscriber._id); } catch { /* The confirmed subscriber remains queued for the existing publishing worker retry path. */ }
  return true;
}

async function processNewsletterWelcomeEmails(now = new Date(), onlyId) {
  const filter = { status: "active", confirmedAt: { $ne: null }, "consent.acceptedAt": { $ne: null }, welcomeEmailStatus: { $in: ["queued", "processing"] }, welcomeEmailAttempts: { $lt: 5 }, welcomeEmailNextAttemptAt: { $lte: now }, $or: [{ welcomeEmailLeaseUntil: null }, { welcomeEmailLeaseUntil: { $lte: now } }] };
  if (onlyId) filter._id = onlyId;
  const candidates = await NewsletterSubscriber.find(filter).sort({ welcomeEmailQueuedAt: 1 }).limit(onlyId ? 1 : 20).select("email unsubscribeTokenVersion subscriptionEventId");
  for (const candidate of candidates) {
    const leaseUntil = new Date(now.getTime() + 2 * 60 * 1000);
    const claimed = await NewsletterSubscriber.findOneAndUpdate({ _id: candidate._id, subscriptionEventId: candidate.subscriptionEventId || null, status: "active", confirmedAt: { $ne: null }, "consent.acceptedAt": { $ne: null }, welcomeEmailStatus: { $in: ["queued", "processing"] }, welcomeEmailAttempts: { $lt: 5 }, welcomeEmailNextAttemptAt: { $lte: now }, $or: [{ welcomeEmailLeaseUntil: null }, { welcomeEmailLeaseUntil: { $lte: now } }] }, { $set: { welcomeEmailStatus: "processing", welcomeEmailLeaseUntil: leaseUntil }, $inc: { welcomeEmailAttempts: 1 } }, { new: true }).select("email unsubscribeTokenVersion subscriptionEventId welcomeEmailAttempts");
    if (!claimed) continue;
    const eventFilter = { _id: claimed._id, subscriptionEventId: claimed.subscriptionEventId || null, status: "active", welcomeEmailStatus: "processing", welcomeEmailLeaseUntil: leaseUntil };
    const siteOrigin = origin();
    const serviceOrigin = apiOrigin();
    let outcome = { status: "not_configured" };
    try {
      const eventStillCurrent = await NewsletterSubscriber.exists({ _id: claimed._id, subscriptionEventId: claimed.subscriptionEventId || null, status: "active", welcomeEmailStatus: "processing", welcomeEmailLeaseUntil: leaseUntil });
      if (eventStillCurrent && siteOrigin) {
        const unsubscribeToken = makeUnsubscribeToken(claimed._id, claimed.unsubscribeTokenVersion || 0);
        const unsubscribeUrl = `${siteOrigin}/newsletter/unsubscribe/${claimed._id}?token=${encodeURIComponent(unsubscribeToken)}`;
        const listUnsubscribeUrl = serviceOrigin ? `${serviceOrigin}/api/newsletter/unsubscribe?id=${claimed._id}&token=${encodeURIComponent(unsubscribeToken)}` : "";
        outcome = await sendNewsletterWelcomeEmail({ email: claimed.email, websiteUrl: siteOrigin, newsInsightsUrl: `${siteOrigin}/news-insights`, unsubscribeUrl, listUnsubscribeUrl });
      }
    } catch { outcome = { status: "failed" }; }
    if (outcome.status === "sent") {
      await NewsletterSubscriber.updateOne(eventFilter, { $set: { welcomeEmailStatus: "sent", welcomeEmailLeaseUntil: null, welcomeEmailSentAt: new Date(), welcomeEmailLastError: "", welcomeEmailMessageId: String(outcome.messageId || "").slice(0, 200) } });
    } else {
      const isFinal = claimed.welcomeEmailAttempts >= 5;
      await NewsletterSubscriber.updateOne(eventFilter, { $set: { welcomeEmailStatus: isFinal ? "failed" : "queued", welcomeEmailLeaseUntil: null, welcomeEmailNextAttemptAt: new Date(now.getTime() + backoff(claimed.welcomeEmailAttempts)), welcomeEmailLastError: outcome.status === "not_configured" ? "Welcome email service is not configured." : "Welcome email delivery failed." } });
    }
  }
}

export async function unsubscribeNewsletter(subscriberId, token) {
  if (!mongoose.isValidObjectId(subscriberId) || typeof token !== "string") return false;
  const [expiryText, versionText, signature] = token.split(".");
  const expiresAt = Number(expiryText);
  const version = Number(versionText);
  if (!Number.isSafeInteger(version) || version < 0) return false;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || !/^[A-Za-z0-9_-]{40,60}$/.test(signature || "")) return false;
  const secret = process.env.SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error("Newsletter token service is not configured.");
  const expected = crypto.createHmac("sha256", secret).update(`newsletter-unsubscribe:${subscriberId}:${version}:${expiresAt}`).digest("base64url");
  const a = Buffer.from(expected); const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const unsubscribedAt = new Date();
  const result = await NewsletterSubscriber.updateOne({ _id: subscriberId, unsubscribeTokenVersion: version, status: { $ne: "unsubscribed" } }, { $set: { status: "unsubscribed", unsubscribedAt }, $addToSet: { unsubscribeHistory: unsubscribedAt } });
  if (!result.matchedCount && !await NewsletterSubscriber.exists({ _id: subscriberId, unsubscribeTokenVersion: version, status: "unsubscribed" })) return false;
  return result.matchedCount > 0 || Boolean(await NewsletterSubscriber.exists({ _id: subscriberId, status: "unsubscribed" }));
}

export async function suppressNewsletterSubscriber(subscriberId, now = new Date()) {
  if (!mongoose.isValidObjectId(subscriberId)) return null;
  const current = await NewsletterSubscriber.findById(subscriberId).select("email status subscribedAt consent unsubscribeHistory");
  if (!current) return null;

  let changed = false;
  if (current.status !== "unsubscribed") {
    const updated = await NewsletterSubscriber.findOneAndUpdate(
      { _id: subscriberId, status: { $ne: "unsubscribed" } },
      { $set: { status: "unsubscribed", unsubscribedAt: now }, $addToSet: { unsubscribeHistory: now }, $inc: { unsubscribeTokenVersion: 1 } },
      { new: true },
    );
    changed = Boolean(updated);
  }

  const pendingDeliveries = await NewsletterDelivery.find({ subscriberId, status: { $in: ["queued", "processing"] } }).select("campaignId").lean();
  const suppressed = await NewsletterDelivery.updateMany(
    { subscriberId, status: { $in: ["queued", "processing"] } },
    { $set: { status: "suppressed", leaseUntil: null, failureCode: "subscriber_removed", lastError: "" } },
  );
  const affectedCampaignIds = [...new Set(pendingDeliveries.map((delivery) => String(delivery.campaignId)))];
  for (const campaignId of affectedCampaignIds) {
    const totals = await NewsletterDelivery.aggregate([{ $match: { campaignId: new mongoose.Types.ObjectId(campaignId) } }, { $group: { _id: "$status", count: { $sum: 1 } } }]);
    const counts = Object.fromEntries(totals.map(({ _id, count }) => [_id, count]));
    await NewsletterCampaign.updateOne({ _id: campaignId }, { $set: { sentCount: counts.sent || 0, failedCount: counts.failed || 0, suppressedCount: counts.suppressed || 0 } });
  }
  const subscriber = await NewsletterSubscriber.findById(subscriberId).select("email status subscribedAt unsubscribedAt consent").lean();
  return { subscriber, changed, suppressedCount: suppressed.modifiedCount || 0 };
}

async function campaignSnapshot(type, source, event, initiatedBy = null) {
  const slug = source.slug;
  const targetUrl = type === "course" ? `${origin()}/services/courses/${encodeURIComponent(slug)}` : newsUrl(type, slug);
  const imageSnapshot = await campaignImageReference(type, source);
  const image = type === "course" ? source.coverImage : (source.images || []).find((entry) => entry.filename === source.thumbnailFilename);
  return { idempotencyKey: event.idempotencyKey, type, sourceId: source._id, eventId: event._id, titleSnapshot: source.title, summarySnapshot: plain(source.summary || source.shortDescription || source.description).slice(0, 500), categorySnapshot: type === "course" ? "" : plain(source.category).slice(0, 100), urlSnapshot: targetUrl, imageSnapshot, imageMediaId: imageSnapshot.startsWith("/api/media/") ? image?.mediaId || null : null, initiatedBy };
}

export async function queuePublication({ type, source, eventType = "first_published", initiatedBy = null, uniqueKey }) {
  const key = uniqueKey || `${type}:${source._id}:${eventType}`;
  let event = await PublicationEvent.findOne({ idempotencyKey: key });
  if (!event) {
    try { event = await PublicationEvent.create({ idempotencyKey: key, contentType: type, sourceId: source._id, eventType, initiatedBy }); }
    catch (error) { if (error.code !== 11000) throw error; event = await PublicationEvent.findOne({ idempotencyKey: key }); }
  }
  let campaign = await NewsletterCampaign.findOne({ idempotencyKey: key });
  if (!campaign) {
    try { campaign = await NewsletterCampaign.create(await campaignSnapshot(type, source, event, initiatedBy)); }
    catch (error) { if (error.code !== 11000) throw error; campaign = await NewsletterCampaign.findOne({ idempotencyKey: key }); }
  }
  if (campaign && !event.campaignId) { event.campaignId = campaign._id; await event.save(); }
  return campaign;
}

export async function processPublishingWorkerOnce(now = new Date()) {
  await processNewsletterWelcomeEmails(now);
  const Article = ContentArticle;
  const Course = (await import("../courses/course.model.js")).default;
  const due = await Article.find({ status: "scheduled", scheduledAt: { $lte: now } }).limit(25);
  for (const article of due) { article.status = "published"; article.publishedAt = now; article.announcementStatus = "pending"; await article.save(); }
  const pendingArticles = await Article.find({ status: "published", announcementStatus: "pending" }).limit(25);
  for (const article of pendingArticles) { await queuePublication({ type: article.contentType, source: article }); article.announcementStatus = "queued"; await article.save(); }
  const pendingCourses = await Course.find({ status: "published", publishedAt: { $lte: now }, announcementStatus: "pending" }).limit(25);
  for (const course of pendingCourses) { await queuePublication({ type: "course", source: course }); course.announcementStatus = "queued"; await course.save(); }

  const campaigns = await NewsletterCampaign.find({ status: { $in: ["queued", "processing"] }, nextAttemptAt: { $lte: now }, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] }).sort({ createdAt: 1 }).limit(10);
  for (const campaign of campaigns) {
    const claimed = await NewsletterCampaign.findOneAndUpdate({ _id: campaign._id, status: { $in: ["queued", "processing"] }, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] }, { $set: { status: "processing", leaseUntil: new Date(now.getTime() + 60_000), startedAt: campaign.startedAt || now }, $inc: { attempts: 1 } }, { new: true });
    if (!claimed) continue;
    if (!claimed.recipientsMaterialized) {
      const filter = { status: "active", confirmedAt: { $ne: null }, "consent.acceptedAt": { $ne: null } };
      if (claimed.recipientCursor) filter._id = { $gt: claimed.recipientCursor };
      const recipients = await NewsletterSubscriber.find(filter).select("_id").sort({ _id: 1 }).limit(500);
      if (recipients.length) {
        await NewsletterDelivery.insertMany(recipients.map((s) => ({ campaignId: claimed._id, subscriberId: s._id })), { ordered: false }).catch((e) => { if (e.code !== 11000 && !e.writeErrors?.every((x) => x.code === 11000)) throw e; });
        claimed.recipientCursor = recipients.at(-1)._id;
        claimed.eligibleCount += recipients.length;
      }
      claimed.recipientsMaterialized = recipients.length < 500;
      await claimed.save();
    }
    const deliveries = await NewsletterDelivery.find({ campaignId: claimed._id, status: { $in: ["queued", "failed", "processing"] }, attempts: { $lt: 5 }, nextAttemptAt: { $lte: now }, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] }).sort({ createdAt: 1 }).limit(25);
    for (const delivery of deliveries) {
      const liveCampaign = await NewsletterCampaign.findById(claimed._id).select("status");
      if (!liveCampaign || liveCampaign.status === "cancelled") break;
      const leased = await NewsletterDelivery.findOneAndUpdate({ _id: delivery._id, status: { $in: ["queued", "failed", "processing"] }, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] }, { $set: { status: "processing", leaseUntil: new Date(now.getTime() + 60_000), lastAttemptAt: now }, $inc: { attempts: 1 } }, { new: true });
      if (!leased) continue;
      const [subscriber, freshCampaign] = await Promise.all([NewsletterSubscriber.findById(leased.subscriberId).select("email status confirmedAt consent.acceptedAt +unsubscribeTokenVersion"), NewsletterCampaign.findById(leased.campaignId)]);
      const source = freshCampaign?.type === "course" ? await Course.findById(freshCampaign.sourceId).lean() : await Article.findById(freshCampaign.sourceId).lean();
      if (!subscriber || subscriber.status !== "active" || !subscriber.confirmedAt || !subscriber.consent?.acceptedAt || !freshCampaign || freshCampaign.status === "cancelled" || (freshCampaign.type === "course" ? source?.status !== "published" : source?.status !== "published")) {
        await NewsletterDelivery.updateOne({ _id: leased._id, status: "processing", leaseUntil: leased.leaseUntil }, { $set: { status: "suppressed", leaseUntil: null, failureCode: "not_eligible" } }); continue;
      }
      const base = origin();
      const token = makeUnsubscribeToken(subscriber._id, subscriber.unsubscribeTokenVersion || 0);
      const unsubscribeUrl = `${base}/newsletter/unsubscribe/${subscriber._id}?token=${token}`;
      const unsubscribeApiOrigin = apiOrigin();
      const listUnsubscribeUrl = unsubscribeApiOrigin ? `${unsubscribeApiOrigin}/api/newsletter/unsubscribe?id=${subscriber._id}&token=${token}` : "";
      const image = await campaignImageUrl(freshCampaign);
      const result = await sendNewsletterAnnouncementEmail({ email: subscriber.email, unsubscribeUrl, listUnsubscribeUrl, content: { type: freshCampaign.type, title: freshCampaign.titleSnapshot, summary: freshCampaign.summarySnapshot, category: freshCampaign.categorySnapshot, url: freshCampaign.urlSnapshot, image } });
      if (result.status === "sent") {
        await NewsletterDelivery.updateOne({ _id: leased._id, status: "processing", leaseUntil: leased.leaseUntil }, { $set: { status: "sent", acceptedAt: new Date(), providerMessageId: String(result.messageId || "").slice(0, 200), lastError: "", leaseUntil: null } });
      } else {
        const status = leased.attempts >= leased.maxAttempts || result.status === "not_configured" ? "failed" : "queued";
        await NewsletterDelivery.updateOne({ _id: leased._id, status: "processing", leaseUntil: leased.leaseUntil }, { $set: { status, failureCode: result.status === "not_configured" ? "not_configured" : "provider_failure", lastError: result.status === "not_configured" ? "Email delivery is not configured." : "Email provider rejected this delivery.", nextAttemptAt: new Date(now.getTime() + backoff(leased.attempts)), leaseUntil: null } });
      }
    }
    const [sentCount, failedCount, suppressedCount, remaining] = await Promise.all([NewsletterDelivery.countDocuments({ campaignId: claimed._id, status: "sent" }), NewsletterDelivery.countDocuments({ campaignId: claimed._id, status: "failed" }), NewsletterDelivery.countDocuments({ campaignId: claimed._id, status: "suppressed" }), NewsletterDelivery.countDocuments({ campaignId: claimed._id, status: { $in: ["queued", "processing"] } })]);
    claimed.sentCount = sentCount; claimed.failedCount = failedCount; claimed.suppressedCount = suppressedCount; claimed.leaseUntil = null;
    if (!remaining) { claimed.status = failedCount ? "failed" : "sent"; claimed.completedAt = now; }
    else { claimed.status = "queued"; claimed.nextAttemptAt = new Date(now.getTime() + 1000); }
    await claimed.save();
    if (claimed.completedAt) await PublicationEvent.updateOne({ _id: claimed.eventId, status: { $in: ["queued", "processing"] } }, { $set: { status: "completed" } });
  }
}

export async function cleanupUnreferencedPublishingUploads(now = new Date()) {
  const root = PUBLISHING_UPLOAD_ROOT;
  let names; try { names = await fs.readdir(root); } catch (error) { if (error.code === "ENOENT") return 0; throw error; }
  let removed = 0;
  for (const filename of names) {
    if (!/^[a-f\d-]{36}\.(png|jpe?g|webp)$/i.test(filename)) continue;
    const filepath = path.join(root, filename);
    const stat = await fs.stat(filepath).catch(() => null);
    if (!stat || now.getTime() - stat.mtimeMs < 24 * 60 * 60 * 1000) continue;
    const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const [articleReferenced, campaignReferenced] = await Promise.all([
      ContentArticle.exists({ $or: [{ thumbnailFilename: filename }, { "images.filename": filename }] }),
      NewsletterCampaign.exists({ imageSnapshot: { $regex: new RegExp(`/api/news/assets/${escapedFilename}(?:$|[?#])`, "i") } }),
    ]);
    const referenced = articleReferenced || campaignReferenced;
    if (!referenced) { await fs.unlink(filepath).catch((error) => { if (error.code !== "ENOENT") throw error; }); removed += 1; }
  }
  return removed;
}

let workerTimer;
let cleanupTimer;
export function startPublishingWorker() { if (workerTimer) return; void processPublishingWorkerOnce().catch(() => {}); workerTimer = setInterval(() => processPublishingWorkerOnce().catch(() => {}), 5000); cleanupTimer = setInterval(() => cleanupUnreferencedPublishingUploads().catch(() => {}), 60 * 60 * 1000); workerTimer.unref?.(); cleanupTimer.unref?.(); }
export function stopPublishingWorker() { if (workerTimer) clearInterval(workerTimer); if (cleanupTimer) clearInterval(cleanupTimer); workerTimer = null; cleanupTimer = null; }

export async function publicArticles({ type, page = 1, limit = 12, search, category }) {
  const filter = { contentType: type, status: "published", publishedAt: { $lte: new Date() } };
  if (category) filter.category = String(category).slice(0, 100);
  if (search) filter.$text = { $search: String(search).slice(0, 100) };
  const safePage = Math.max(1, Number(page) || 1); const safeLimit = Math.min(30, Math.max(1, Number(limit) || 12));
  const [items, total] = await Promise.all([ArticleFind(filter).sort({ publishedAt: -1, _id: -1 }).skip((safePage - 1) * safeLimit).limit(safeLimit).lean(), ArticleFind(filter).countDocuments()]);
  return { items: items.map(publicArticle), pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) } };
}
function ArticleFind(filter) { return ContentArticle.find(filter).select("-createdBy -updatedBy -__v -announcementStatus -scheduledAt"); }
function publicArticle(item) {
  const { announcementStatus, scheduledAt, createdBy, updatedBy, __v, ...visible } = item;
  const imagePath = (image) => image?.mediaId ? `/api/media/${image.mediaId}` : `/api/news/assets/${encodeURIComponent(image.filename)}`;
  visible.images = (visible.images || []).map((image) => ({ ...image, url: publicAssetUrl(imagePath(image)) }));
  const cover = (visible.images || []).find((image) => image.filename === visible.thumbnailFilename);
  visible.thumbnailMediaId = cover?.mediaId || null;
  visible.thumbnailUrl = cover ? publicAssetUrl(imagePath(cover)) : visible.thumbnailFilename ? publicAssetUrl(`/api/news/assets/${encodeURIComponent(visible.thumbnailFilename)}`) : null;
  return visible;
}
export const serializePublicArticle = publicArticle;
export async function articleBySlug(type, slug) {
  const item = await ContentArticle.findOne({ contentType: type, slug, status: "published", publishedAt: { $lte: new Date() } }).select("-createdBy -updatedBy -__v -announcementStatus -scheduledAt").lean();
  return item ? publicArticle(item) : null;
}
export const publishingInternals = { plain, tokenHash, backoff };
