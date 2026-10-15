import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import mongoose from "mongoose";

let memoryServer, server, api, restoreTransport;
let Subscriber, Article, Campaign, Delivery, Event, AdminAudit, processWorker, subscribeNewsletter, confirmNewsletter, unsubscribeNewsletter, makeUnsubscribeToken, queuePublication, sendNewsletterWelcomeEmail;
let Admin, hashPassword;
const emailMessages = [];
const TEST_DATABASE = "projenius_publishing_isolated_test";
const TEST_UPLOADS = path.join(os.tmpdir(), `projenius-publishing-uploads-${process.pid}-${randomUUID()}`);
let failNextEmail = false;

function syntheticPng(width, height) {
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const nameBytes = Buffer.from(name);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([nameBytes, data])));
    return Buffer.concat([length, nameBytes, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const offset = y * (1 + width * 4); rows[offset] = 0;
    for (let x = 0; x < width; x += 1) { const pixel = offset + 1 + x * 4; rows[pixel] = 20; rows[pixel + 1] = 120; rows[pixel + 2] = 180; rows[pixel + 3] = 255; }
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

before(async () => {
  delete process.env.MONGODB_URI;
  process.env.NODE_ENV = "test";
  process.env.MONGOMS_RUNTIME_DOWNLOAD = "false";
  process.env.ADMIN_SITE_ORIGIN = "http://localhost:5174";
  process.env.PUBLIC_SITE_ORIGIN = "http://localhost:5173";
  process.env.PUBLIC_API_ORIGIN = "http://localhost:5000";
  process.env.PRIVATE_UPLOAD_DIR = TEST_UPLOADS;
  process.env.SESSION_SECRET = randomBytes(48).toString("hex");
  process.env.GMAIL_USER = "synthetic-sender@example.invalid";
  process.env.GMAIL_APP_PASSWORD = "synthetic-unused-password";
  const { MongoMemoryServer } = await import("mongodb-memory-server");
  memoryServer = await MongoMemoryServer.create({ instance: { dbName: TEST_DATABASE, ip: "127.0.0.1" } });
  const uri = memoryServer.getUri(TEST_DATABASE);
  const parsed = new URL(uri);
  if (parsed.protocol !== "mongodb:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password) throw new Error("Publishing tests require credential-free loopback MongoDB only.");
  process.env.MONGODB_URI = uri;
  const { connectDatabase } = await import("../src/config/database.js");
  await connectDatabase();
  ({ default: Subscriber } = await import("../src/modules/publishing/newsletterSubscriber.model.js"));
  ({ default: Article } = await import("../src/modules/publishing/contentArticle.model.js"));
  ({ default: Campaign } = await import("../src/modules/publishing/newsletterCampaign.model.js"));
  ({ default: Delivery } = await import("../src/modules/publishing/newsletterDelivery.model.js"));
  ({ default: Event } = await import("../src/modules/publishing/publicationEvent.model.js"));
  ({ default: AdminAudit } = await import("../src/modules/admin/management/adminAudit.model.js"));
  ({ default: Admin } = await import("../src/modules/admin/auth/admin.model.js"));
  ({ hashPassword } = await import("../src/modules/admin/auth/auth.service.js"));
  ({ processPublishingWorkerOnce: processWorker, subscribeNewsletter, confirmNewsletter, unsubscribeNewsletter, makeUnsubscribeToken, queuePublication } = await import("../src/modules/publishing/publishing.service.js"));
  await Promise.all([Subscriber, Article, Campaign, Delivery, Event].map((Model) => Model.createIndexes()));
  const { setEmailTransportForTests, sendNewsletterWelcomeEmail: sendWelcome } = await import("../src/shared/email/email.service.js");
  sendNewsletterWelcomeEmail = sendWelcome;
  restoreTransport = setEmailTransportForTests({ async sendMail(message) { emailMessages.push(message); if (failNextEmail) { failNextEmail = false; throw Object.assign(new Error("synthetic failure"), { code: "ETEST" }); } return { messageId: `synthetic-${randomUUID()}` }; } });
  const { default: app } = await import("../src/app.js");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  api = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  restoreTransport?.();
  if (server) await new Promise((resolve) => server.close(resolve));
  const mongoose = (await import("mongoose")).default;
  await mongoose.disconnect();
  await memoryServer?.stop();
  await fs.rm(TEST_UPLOADS, { recursive: true, force: true });
  delete process.env.MONGODB_URI;
});

test("newsletter endpoint directly activates a consented subscriber and sends one welcome email", async () => {
  const noConsent = await fetch(`${api}/api/newsletter/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "  Reader@Example.Invalid " }) });
  assert.equal(noConsent.status, 400);
  assert.equal(await Subscriber.countDocuments({ email: "reader@example.invalid" }), 0);
  const response = await fetch(`${api}/api/newsletter/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "  Reader@Example.Invalid ", consent: true }) });
  assert.equal(response.status, 202);
  const data = await response.json();
  assert.equal(data.status, "subscribed");
  assert.equal(data.emailStatus, "sent");
  assert.match(data.message, /welcome email has been sent/i);
  const readerMessages = emailMessages.filter((message) => message.to === "reader@example.invalid");
  assert.equal(readerMessages.length, 1);
  const welcome = readerMessages[0];
  assert.equal(welcome.subject, "Welcome to ProJenius News & Insights!");
  assert.match(welcome.text, /Thank you for subscribing to ProJenius Innovation Technology Private Limited/);
  assert.match(welcome.text, /Visit ProJenius: http:\/\/localhost:5173/);
  assert.match(welcome.text, /Explore News & Insights: http:\/\/localhost:5173\/news-insights/);
  assert.match(welcome.text, /Unsubscribe:/);
  assert.doesNotMatch(welcome.subject, /confirm/i);
  const consentedSubscriber = await Subscriber.findOne({ email: "reader@example.invalid" }).select("+confirmationTokenHash");
  assert.equal(consentedSubscriber.status, "active");
  assert.ok(consentedSubscriber.consent.acceptedAt instanceof Date);
  assert.equal(consentedSubscriber.consent.source, "website-footer");
  assert.ok(consentedSubscriber.subscribedAt instanceof Date);
  assert.ok(consentedSubscriber.confirmedAt instanceof Date);
  assert.equal(consentedSubscriber.confirmationTokenHash, undefined, "direct subscriptions do not create a confirmation token");
  const duplicate = await fetch(`${api}/api/newsletter/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "reader@example.invalid", consent: true }) });
  assert.equal(duplicate.status, 200);
  const duplicateBody = await duplicate.json();
  assert.equal(duplicateBody.status, "already_subscribed");
  assert.match(duplicateBody.message, /already subscribed/i);
  assert.equal(emailMessages.filter((message) => message.to === "reader@example.invalid").length, 1, "repeat requests send no duplicate welcome email");
  assert.equal(await Subscriber.countDocuments({ email: "reader@example.invalid" }), 1);
});

test("welcome email failure keeps the subscriber active and retries through the existing worker", async () => {
  failNextEmail = true;
  const subscribeResponse = await fetch(`${api}/api/newsletter/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "welcome-retry@example.invalid", consent: true }) });
  assert.equal(subscribeResponse.status, 202);
  const subscribeBody = await subscribeResponse.json();
  assert.equal(subscribeBody.status, "subscribed");
  assert.equal(subscribeBody.emailStatus, "queued");
  assert.match(subscribeBody.message, /we'll retry/i);
  let subscriber = await Subscriber.findOne({ email: "welcome-retry@example.invalid" });
  assert.equal(subscriber.status, "active");
  assert.equal(subscriber.welcomeEmailStatus, "queued");
  assert.equal(subscriber.welcomeEmailAttempts, 1);
  await processWorker(new Date(Date.now() + 35_000));
  subscriber = await Subscriber.findOne({ email: "welcome-retry@example.invalid" });
  assert.equal(subscriber.status, "active");
  assert.equal(subscriber.welcomeEmailStatus, "sent");
  assert.equal(subscriber.welcomeEmailAttempts, 2);
  const repeated = await fetch(`${api}/api/newsletter/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "welcome-retry@example.invalid", consent: true }) });
  assert.equal((await repeated.json()).status, "already_subscribed");
  assert.equal(emailMessages.filter((message) => message.to === "welcome-retry@example.invalid").length, 2, "only the failed attempt and one successful retry are sent");
});

test("concurrent consented requests create one subscriber and one welcome email", async () => {
  const address = "concurrent-newsletter@example.invalid";
  const results = await Promise.all([subscribeNewsletter(address, true), subscribeNewsletter(address, true)]);
  assert.equal(results.filter((result) => result.status === "subscribed").length, 1);
  assert.equal(results.filter((result) => result.status === "already_subscribed").length, 1);
  assert.equal(await Subscriber.countDocuments({ email: address }), 1);
  assert.equal(emailMessages.filter((message) => message.to === address).length, 1);
});

test("welcome email uses the configured HTTPS website and News & Insights links", async () => {
  const previousOrigin = process.env.PUBLIC_SITE_ORIGIN;
  process.env.PUBLIC_SITE_ORIGIN = "https://www.projenius.example.invalid";
  try {
    const result = await sendNewsletterWelcomeEmail({ email: "https-links@example.invalid", websiteUrl: "https://www.projenius.example.invalid", newsInsightsUrl: "https://www.projenius.example.invalid/news-insights", unsubscribeUrl: "https://www.projenius.example.invalid/newsletter/unsubscribe/synthetic?token=synthetic" });
    assert.equal(result.status, "sent");
    const message = emailMessages.at(-1);
    assert.match(message.text, /Visit ProJenius: https:\/\/www\.projenius\.example\.invalid/);
    assert.match(message.text, /Explore News & Insights: https:\/\/www\.projenius\.example\.invalid\/news-insights/);
    assert.match(message.html, /href="https:\/\/www\.projenius\.example\.invalid\/"/);
    assert.match(message.html, /href="https:\/\/www\.projenius\.example\.invalid\/news-insights"/);
  } finally {
    process.env.PUBLIC_SITE_ORIGIN = previousOrigin;
  }
});

test("legacy pending confirmation links remain valid without affecting new direct subscriptions", async () => {
  const token = randomBytes(32).toString("base64url");
  await Subscriber.create({ email: "legacy-pending@example.invalid", status: "pending", confirmationTokenHash: createHash("sha256").update(token).digest("hex"), confirmationTokenExpiresAt: new Date(Date.now() + 60_000), consent: { source: "website-footer", acceptedAt: new Date() } });
  assert.equal(await confirmNewsletter(token), true);
  assert.equal((await Subscriber.findOne({ email: "legacy-pending@example.invalid" })).status, "active");
  assert.equal(emailMessages.filter((message) => message.to === "legacy-pending@example.invalid").length, 1, "the existing legacy token flow still sends its welcome email once");
  assert.equal(await confirmNewsletter(token), false);
});

test("unconfirmed and unsubscribed records are excluded from campaign delivery", async () => {
  const pending = await Subscriber.create({ email: "pending@example.invalid", status: "pending" });
  const active = await Subscriber.create({ email: "active@example.invalid", status: "active", confirmedAt: new Date(), consent: { source: "website-footer", acceptedAt: new Date() } });
  const activeWithoutConsent = await Subscriber.create({ email: "active-without-consent@example.invalid", status: "active", confirmedAt: new Date() });
  const source = await Article.create({ contentType: "news", title: "Synthetic publication", slug: `synthetic-${randomUUID()}`, summary: "Public summary only", body: "Safe synthetic article", status: "published", publishedAt: new Date(), announcementStatus: "pending", createdBy: new (await import("mongoose")).default.Types.ObjectId(), updatedBy: new (await import("mongoose")).default.Types.ObjectId() });
  await processWorker();
  const campaign = await Campaign.findOne({ sourceId: source._id });
  assert.ok(campaign);
  assert.equal(await Delivery.countDocuments({ campaignId: campaign._id, subscriberId: pending._id }), 0);
  assert.equal(await Delivery.countDocuments({ campaignId: campaign._id, subscriberId: activeWithoutConsent._id }), 0, "active records without recorded consent are excluded from marketing campaigns");
  await processWorker(new Date(Date.now() + 3000));
  assert.equal(await Delivery.countDocuments({ campaignId: campaign._id, subscriberId: active._id, status: "sent" }), 1, JSON.stringify({ campaign: await Campaign.findById(campaign._id).lean(), deliveries: await Delivery.find({ campaignId: campaign._id }).lean() }));
  assert.ok(emailMessages.some((message) => message.to === "active@example.invalid"));
  assert.ok(!emailMessages.some((message) => message.to === "pending@example.invalid"));
  assert.equal((await subscribeNewsletter(activeWithoutConsent.email, true)).status, "already_subscribed");
  assert.ok((await Subscriber.findById(activeWithoutConsent._id)).consent.acceptedAt instanceof Date, "an explicit submit records consent for a legacy active account");
  assert.equal(await Delivery.countDocuments({ campaignId: campaign._id, subscriberId: activeWithoutConsent._id }), 0);
  const sendsBefore = emailMessages.length;
  await processWorker();
  assert.equal(emailMessages.length, sendsBefore);
  assert.equal(await Campaign.countDocuments({ sourceId: source._id }), 1);
});

test("queued deliveries recheck unsubscribe status and suppress the recipient", async () => {
  const source = await Article.create({ contentType: "blog", title: "Suppression test", slug: `suppress-${randomUUID()}`, summary: "Summary", body: "Body", status: "published", publishedAt: new Date(), announcementStatus: "queued", createdBy: new (await import("mongoose")).default.Types.ObjectId(), updatedBy: new (await import("mongoose")).default.Types.ObjectId() });
  const subscriber = await Subscriber.create({ email: "suppress@example.invalid", status: "active", confirmedAt: new Date(), consent: { source: "website-footer", acceptedAt: new Date() } });
  const campaign = await queuePublication({ type: "blog", source, uniqueKey: `test:${randomUUID()}` });
  campaign.recipientsMaterialized = true;
  campaign.eligibleCount = 1;
  await campaign.save();
  await Delivery.create({ campaignId: campaign._id, subscriberId: subscriber._id, status: "queued" });
  assert.equal(await unsubscribeNewsletter(subscriber._id, makeUnsubscribeToken(subscriber._id)), true);
  const sendsBefore = emailMessages.length;
  await processWorker();
  assert.equal(await Delivery.countDocuments({ campaignId: campaign._id, subscriberId: subscriber._id, status: "suppressed" }), 1);
  assert.equal(emailMessages.length, sendsBefore);
});

test("previously unsubscribed addresses require fresh consent and preserve unsubscribe history", async () => {
  const subscriber = await Subscriber.create({ email: "resubscribe@example.invalid", status: "active", confirmedAt: new Date(), consent: { source: "website-footer", acceptedAt: new Date() } });
  const oldUnsubscribeToken = makeUnsubscribeToken(subscriber._id);
  assert.equal(await unsubscribeNewsletter(subscriber._id, oldUnsubscribeToken), true);
  assert.equal(await unsubscribeNewsletter(subscriber._id, oldUnsubscribeToken), true, "repeated unsubscribe remains idempotent");
  const priorUnsubscribedAt = (await Subscriber.findById(subscriber._id)).unsubscribedAt;
  assert.equal((await Subscriber.findById(subscriber._id)).unsubscribeHistory.length, 1);
  await assert.rejects(subscribeNewsletter(subscriber.email), /consent is required/i);
  assert.equal((await Subscriber.findById(subscriber._id)).status, "unsubscribed");
  const beforeEmails = emailMessages.filter((message) => message.to === subscriber.email).length;
  const renewedResults = await Promise.all([subscribeNewsletter(subscriber.email, true), subscribeNewsletter(subscriber.email, true)]);
  assert.equal(renewedResults.filter((result) => result.status === "subscribed").length, 1);
  assert.equal(renewedResults.filter((result) => result.status === "already_subscribed").length, 1);
  const resubscribed = await Subscriber.findById(subscriber._id);
  assert.equal(resubscribed.status, "active");
  assert.ok(resubscribed.consent.acceptedAt > priorUnsubscribedAt);
  assert.equal(resubscribed.consent.source, "website-footer");
  assert.equal(resubscribed.unsubscribedAt.getTime(), priorUnsubscribedAt.getTime(), "the previous unsubscribe timestamp is retained");
  assert.equal(resubscribed.unsubscribeHistory.length, 1);
  assert.equal(emailMessages.filter((message) => message.to === subscriber.email).length, beforeEmails + 1, "renewed consent queues one new welcome email");
  assert.equal(resubscribed.consentHistory.length, 2, "initial and renewed consent timestamps are retained as distinct subscription events");
  assert.notEqual(resubscribed.consentHistory[0].eventId, resubscribed.consentHistory[1].eventId);
  const renewedEventId = resubscribed.subscriptionEventId;
  assert.equal((await subscribeNewsletter(subscriber.email, true)).status, "already_subscribed");
  assert.equal((await Subscriber.findById(subscriber._id)).subscriptionEventId, renewedEventId, "an active duplicate does not create a new subscription event");
  assert.equal(emailMessages.filter((message) => message.to === subscriber.email).length, beforeEmails + 1, "duplicate API retries do not send another welcome email for the event");
  assert.equal(await unsubscribeNewsletter(subscriber._id, oldUnsubscribeToken), false);
  assert.equal(await confirmNewsletter("invalid-or-old-token"), false);
  assert.equal(await unsubscribeNewsletter(subscriber._id, "1.0.invalid-signature"), false, "expired tokens are rejected");

  const { suppressNewsletterSubscriber } = await import("../src/modules/publishing/publishing.service.js");
  const adminRemoved = await Subscriber.create({ email: "admin-removed-resubscribe@example.invalid", status: "active", confirmedAt: new Date(), consent: { source: "website-footer", acceptedAt: new Date("2026-01-01T00:00:00.000Z") } });
  assert.equal((await suppressNewsletterSubscriber(adminRemoved._id)).changed, true);
  const adminRemovedMessages = emailMessages.filter((message) => message.to === adminRemoved.email).length;
  const adminResubscribe = await subscribeNewsletter(adminRemoved.email, true);
  assert.equal(adminResubscribe.status, "subscribed");
  const adminResubscribed = await Subscriber.findById(adminRemoved._id);
  assert.equal(adminResubscribed.status, "active");
  assert.equal(adminResubscribed.consentHistory.length, 2, "the pre-removal consent and renewed consent are both retained");
  assert.equal(emailMessages.filter((message) => message.to === adminRemoved.email).length, adminRemovedMessages + 1);
});

test("duplicate first-publication events reuse one event and campaign", async () => {
  const source = await Article.create({ contentType: "blog", title: "Idempotent post", slug: `idempotent-${randomUUID()}`, summary: "Summary", body: "Body", status: "published", publishedAt: new Date(), createdBy: new (await import("mongoose")).default.Types.ObjectId(), updatedBy: new (await import("mongoose")).default.Types.ObjectId() });
  const first = await queuePublication({ type: "blog", source });
  const second = await queuePublication({ type: "blog", source });
  assert.equal(String(first._id), String(second._id));
  assert.match(first.urlSnapshot, /\/news-insights\/blog\//);
  assert.equal(await Campaign.countDocuments({ sourceId: source._id }), 1);
  assert.equal(await Event.countDocuments({ sourceId: source._id }), 1);
});

test("News & Insights campaign snapshots and safely renders its category", async () => {
  const source = await Article.create({ contentType: "news", title: "Synthetic research update", slug: `news-category-${randomUUID()}`, summary: "A synthetic company update", body: "Synthetic body", category: "Technology & Research", status: "published", publishedAt: new Date(), announcementStatus: "pending", createdBy: new (await import("mongoose")).default.Types.ObjectId(), updatedBy: new (await import("mongoose")).default.Types.ObjectId() });
  const subscriber = await Subscriber.create({ email: "news-category@example.invalid", status: "active", confirmedAt: new Date(), consent: { source: "website-footer", acceptedAt: new Date() } });
  const campaign = await queuePublication({ type: "news", source });
  assert.equal(campaign.categorySnapshot, "Technology & Research");
  assert.match(campaign.urlSnapshot, /\/news-insights\/news\//);
  await processWorker(new Date(Date.now() + 5_000));
  const delivery = await Delivery.findOne({ campaignId: campaign._id, subscriberId: subscriber._id }).lean();
  assert.equal(delivery?.status, "sent", JSON.stringify({ status: delivery?.status, failureCode: delivery?.failureCode }));
  const message = emailMessages.findLast((item) => item.to === subscriber.email);
  assert.ok(message);
  assert.match(message.text, /Category: Technology & Research/);
  assert.match(message.html, /Technology &amp; Research/);
  assert.doesNotMatch(message.html, /<script/i);
});

test("public article and course asset references never emit localhost and preserve configured HTTPS origins", async () => {
  const previousNodeEnvironment = process.env.NODE_ENV;
  const previousPublicApiOrigin = process.env.PUBLIC_API_ORIGIN;
  const { publicAssetUrl } = await import("../src/shared/http/publicAssetUrl.js");
  try {
    process.env.NODE_ENV = "development";
    process.env.PUBLIC_API_ORIGIN = "http://localhost:5000";
    assert.equal(publicAssetUrl("/api/news/assets/cover.jpg"), "/api/news/assets/cover.jpg");
    assert.equal(publicAssetUrl("/api/courses/assets/cover.jpg"), "/api/courses/assets/cover.jpg");
    process.env.NODE_ENV = "production";
    assert.equal(publicAssetUrl("/api/news/assets/cover.jpg"), "/api/news/assets/cover.jpg");
    process.env.PUBLIC_API_ORIGIN = "https://media-api.example.invalid/base";
    assert.equal(publicAssetUrl("/api/news/assets/cover.jpg"), "https://media-api.example.invalid/api/news/assets/cover.jpg");
  } finally {
    process.env.NODE_ENV = previousNodeEnvironment;
    if (previousPublicApiOrigin === undefined) delete process.env.PUBLIC_API_ORIGIN;
    else process.env.PUBLIC_API_ORIGIN = previousPublicApiOrigin;
  }
});

test("unified public listing mixes published Blog and News articles and excludes workflow states", async () => {
  const mongoose = (await import("mongoose")).default;
  const adminId = new mongoose.Types.ObjectId();
  const common = { summary: "Synthetic unified summary", body: "Full synthetic body", category: "Research", status: "published", publishedAt: new Date(), createdBy: adminId, updatedBy: adminId };
  const blog = await Article.create({ ...common, contentType: "blog", title: "Unified synthetic blog", slug: `unified-blog-${randomUUID()}`, author: { name: "Synthetic Author" } });
  const news = await Article.create({ ...common, contentType: "news", title: "Unified synthetic company update", slug: `unified-news-${randomUUID()}` });
  await Article.create({ ...common, contentType: "news", title: "Hidden draft", slug: `unified-draft-${randomUUID()}`, status: "draft", publishedAt: null });
  await Article.create({ ...common, contentType: "blog", title: "Future scheduled", slug: `unified-future-${randomUUID()}`, publishedAt: new Date(Date.now() + 60_000) });
  const response = await fetch(`${api}/api/news?category=Research&limit=30`);
  assert.equal(response.status, 200);
  const result = await response.json();
  const matched = result.items.filter((item) => [String(blog._id), String(news._id)].includes(item._id));
  assert.deepEqual(new Set(matched.map((item) => item.contentType)), new Set(["blog", "news"]));
  assert.ok(matched.every((item) => !("body" in item) && !("announcementStatus" in item) && !("status" in item)));
  const search = await (await fetch(`${api}/api/news?search=${encodeURIComponent("unified synthetic blog")}`)).json();
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].contentType, "blog");
  assert.equal((await fetch(`${api}/api/news/categories`)).status, 200);
});

test("content article indexes retain typed slug uniqueness and add mixed-feed query indexes", async () => {
  const indexes = await Article.collection.indexes();
  const byName = new Map(indexes.map((index) => [index.name, index.key]));
  assert.deepEqual(byName.get("content_type_slug_unique"), { contentType: 1, slug: 1 });
  assert.deepEqual(byName.get("unified_public_content_listing"), { status: 1, publishedAt: -1, _id: -1 });
  assert.deepEqual(byName.get("unified_public_category_listing"), { status: 1, category: 1, publishedAt: -1, _id: -1 });
});

test("article validation enforces five images and allowlists HTTPS YouTube/Vimeo URLs", async () => {
  const { validateArticle, validateVideoUrl } = await import("../src/modules/publishing/publishing.controller.js");
  const images = Array.from({ length: 6 }, (_, index) => ({ filename: `${index}-synthetic.png`, mimeType: "image/png", size: 10 }));
  const base = { contentType: "news", title: "Synthetic media", slug: "synthetic-media", summary: "Summary", body: "Body", images: images.slice(0, 5) };
  assert.equal(validateArticle(base).images.length, 5);
  assert.throws(() => validateArticle({ ...base, images }), { status: 400 });
  assert.deepEqual(validateVideoUrl("https://youtu.be/AbCdEf12345", "Demo"), { provider: "youtube", videoId: "AbCdEf12345", url: "https://www.youtube.com/watch?v=AbCdEf12345", title: "Demo" });
  assert.equal(validateVideoUrl("https://vimeo.com/1234567").provider, "vimeo");
  for (const invalid of ["http://youtu.be/AbCdEf12345", "https://youtube.com.attacker.invalid/watch?v=AbCdEf12345", "javascript:alert(1)", "https://vimeo.com.evil.invalid/1234"]) assert.throws(() => validateVideoUrl(invalid), { status: 400 });
});

test("expired delivery leases recover and public article output omits internal workflow fields", async () => {
  const source = await Article.create({ contentType: "news", title: "Public projection check", slug: `projection-${randomUUID()}`, summary: "Public summary", body: "Public article body", status: "published", publishedAt: new Date(), announcementStatus: "queued", scheduledAt: new Date(Date.now() + 60_000), createdBy: new (await import("mongoose")).default.Types.ObjectId(), updatedBy: new (await import("mongoose")).default.Types.ObjectId() });
  const subscriber = await Subscriber.create({ email: "lease-recovery@example.invalid", status: "active", confirmedAt: new Date(), consent: { source: "website-footer", acceptedAt: new Date() } });
  const campaign = await queuePublication({ type: "news", source, uniqueKey: `lease:${randomUUID()}` });
  campaign.recipientsMaterialized = true;
  campaign.eligibleCount = 1;
  await campaign.save();
  const expired = new Date(Date.now() - 1000);
  await Delivery.create({ campaignId: campaign._id, subscriberId: subscriber._id, status: "processing", attempts: 1, leaseUntil: expired });
  await processWorker();
  assert.equal(await Delivery.countDocuments({ campaignId: campaign._id, subscriberId: subscriber._id, status: "sent" }), 1);

  const listResponse = await fetch(`${api}/api/news/news`);
  const list = await listResponse.json();
  const listed = list.items.find((item) => item.slug === source.slug);
  assert.ok(listed);
  assert.equal("announcementStatus" in listed, false);
  assert.equal("scheduledAt" in listed, false);
  const detailResponse = await fetch(`${api}/api/news/news/${source.slug}`);
  const detail = await detailResponse.json();
  assert.equal("announcementStatus" in detail.item, false);
  assert.equal("scheduledAt" in detail.item, false);
});

test("public routes reject admin data without a session and hide draft articles", async () => {
  const draft = await Article.create({ contentType: "news", title: "Private draft", slug: `draft-${randomUUID()}`, summary: "Not public", body: "Draft", status: "draft", createdBy: new (await import("mongoose")).default.Types.ObjectId(), updatedBy: new (await import("mongoose")).default.Types.ObjectId() });
  const publicList = await fetch(`${api}/api/news/news`);
  assert.equal(publicList.status, 200);
  const result = await publicList.json();
  assert.ok(!result.items.some((item) => item._id === String(draft._id)));
  const protectedList = await fetch(`${api}/api/admin/newsletter/subscribers`);
  assert.equal(protectedList.status, 401);
});

test("subscriber administration filters active states and restricts removal to Super Admin with campaign suppression", async () => {
  const superAdmin = await Admin.create({ name: "Synthetic Newsletter Super Admin", email: `newsletter-root-${randomUUID()}@example.invalid`, passwordHash: await hashPassword("Synthetic-Newsletter-Root-93!"), role: "superadmin", permissions: [] });
  const regularAdmin = await Admin.create({ name: "Synthetic Newsletter Admin", email: `newsletter-admin-${randomUUID()}@example.invalid`, passwordHash: await hashPassword("Synthetic-Newsletter-Admin-94!"), role: "admin", permissions: ["newsletter:subscribers:view"] });
  const active = await Subscriber.create({ email: `active-${randomUUID()}@example.invalid`, status: "active", subscribedAt: new Date("2026-02-03T04:05:00.000Z"), confirmedAt: new Date(), consent: { acceptedAt: new Date(), source: "website-footer" } });
  const unsubscribed = await Subscriber.create({ email: `unsubscribed-${randomUUID()}@example.invalid`, status: "unsubscribed", subscribedAt: new Date("2026-01-02T03:04:00.000Z"), unsubscribedAt: new Date() });
  const pending = await Subscriber.create({ email: `legacy-${randomUUID()}@example.invalid`, status: "pending", subscribedAt: new Date("2025-12-01T02:00:00.000Z") });
  const normalListResponse = await fetch(`${api}/api/admin/newsletter/subscribers`, { headers: { Cookie: "" } });
  assert.equal(normalListResponse.status, 401);

  async function login(admin, password) {
    const origin = "http://localhost:5174";
    const csrfResponse = await fetch(`${api}/api/admin/auth/csrf`, { headers: { Origin: origin } });
    const csrfCookie = csrfResponse.headers.get("set-cookie").split(";")[0];
    const { csrfToken } = await csrfResponse.json();
    const response = await fetch(`${api}/api/admin/auth/login`, { method: "POST", headers: { Origin: origin, Cookie: csrfCookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ email: admin.email, password }) });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get("set-cookie").split(";")[0], csrfToken: (await response.json()).csrfToken, origin };
  }
  const regularSession = await login(regularAdmin, "Synthetic-Newsletter-Admin-94!");
  const forbidden = await fetch(`${api}/api/admin/newsletter/subscribers/${active._id}`, { method: "DELETE", headers: { Origin: regularSession.origin, Cookie: regularSession.cookie, "X-CSRF-Token": regularSession.csrfToken } });
  assert.equal(forbidden.status, 403, "a regular Admin cannot remove subscribers even with the view permission");
  const regularList = await fetch(`${api}/api/admin/newsletter/subscribers?search=${encodeURIComponent(active.email.slice(0, 10))}`, { headers: { Cookie: regularSession.cookie } });
  assert.equal(regularList.status, 200);
  const regularBody = await regularList.json();
  const activeListItem = regularBody.items.find((item) => item._id === String(active._id));
  assert.ok(activeListItem);
  assert.equal(new Date(activeListItem.subscribedAt).toISOString(), "2026-02-03T04:05:00.000Z", "the list returns the actual subscription timestamp");
  assert.ok(regularBody.items.every((item) => ["active", "unsubscribed"].includes(item.status)));
  const activeOnly = await (await fetch(`${api}/api/admin/newsletter/subscribers?status=active`, { headers: { Cookie: regularSession.cookie } })).json();
  assert.ok(activeOnly.items.some((item) => item._id === String(active._id)));
  assert.ok(activeOnly.items.every((item) => item.status === "active"));
  assert.equal((await fetch(`${api}/api/admin/newsletter/subscribers?status=pending`, { headers: { Cookie: regularSession.cookie } })).status, 400);
  const legacyList = await (await fetch(`${api}/api/admin/newsletter/subscribers?legacyPending=true`, { headers: { Cookie: regularSession.cookie } })).json();
  assert.ok(legacyList.items.some((item) => item._id === String(pending._id)));
  const stats = await (await fetch(`${api}/api/admin/newsletter/stats`, { headers: { Cookie: regularSession.cookie } })).json();
  assert.ok(stats.legacyPending >= 1);
  assert.equal(typeof stats.counts.active, "number");
  assert.equal(typeof stats.counts.unsubscribed, "number");

  const article = await Article.create({ contentType: "news", title: "Suppression source", slug: `suppression-source-${randomUUID()}`, summary: "Synthetic campaign summary", body: "Synthetic body", status: "published", publishedAt: new Date(), createdBy: superAdmin._id, updatedBy: superAdmin._id });
  const campaign = await Campaign.create({ idempotencyKey: `subscriber-remove-${randomUUID()}`, type: "news", sourceId: article._id, titleSnapshot: article.title, summarySnapshot: article.summary, urlSnapshot: "https://example.invalid/news/suppression-source" });
  const processingCampaign = await Campaign.create({ idempotencyKey: `subscriber-remove-processing-${randomUUID()}`, type: "news", sourceId: article._id, titleSnapshot: article.title, summarySnapshot: article.summary, urlSnapshot: "https://example.invalid/news/suppression-source" });
  const queued = await Delivery.create({ campaignId: campaign._id, subscriberId: active._id, status: "queued" });
  const processing = await Delivery.create({ campaignId: processingCampaign._id, subscriberId: active._id, status: "processing", leaseUntil: new Date(Date.now() + 30_000) });
  const superSession = await login(superAdmin, "Synthetic-Newsletter-Root-93!");
  const removedResponse = await fetch(`${api}/api/admin/newsletter/subscribers/${active._id}`, { method: "DELETE", headers: { Origin: superSession.origin, Cookie: superSession.cookie, "X-CSRF-Token": superSession.csrfToken } });
  assert.equal(removedResponse.status, 200);
  const removedBody = await removedResponse.json();
  assert.equal(removedBody.item.status, "unsubscribed");
  assert.equal(removedBody.item.suppressedDeliveryCount, 2);
  const saved = await Subscriber.findById(active._id);
  assert.equal(saved.status, "unsubscribed");
  assert.equal(saved.subscribedAt.toISOString(), "2026-02-03T04:05:00.000Z");
  assert.ok(saved.consent.acceptedAt instanceof Date);
  assert.equal((await Delivery.findById(queued._id)).status, "suppressed");
  assert.equal((await Delivery.findById(processing._id)).status, "suppressed");
  assert.equal((await Campaign.findById(campaign._id)).suppressedCount, 1);
  assert.equal((await Campaign.findById(processingCampaign._id)).suppressedCount, 1);
  assert.ok(await Campaign.exists({ _id: campaign._id }), "campaign history is retained");
  assert.ok(await Campaign.exists({ _id: processingCampaign._id }), "other campaign history is retained");
  assert.equal(await AdminAudit.countDocuments({ actorId: superAdmin._id, action: "newsletter.subscriber.removed" }), 1);
  const repeated = await fetch(`${api}/api/admin/newsletter/subscribers/${active._id}`, { method: "DELETE", headers: { Origin: superSession.origin, Cookie: superSession.cookie, "X-CSRF-Token": superSession.csrfToken } });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).item.changed, false);
  assert.equal(await AdminAudit.countDocuments({ actorId: superAdmin._id, action: "newsletter.subscriber.removed" }), 1, "repeated removal is idempotent and does not duplicate the audit event");
  const invalid = await fetch(`${api}/api/admin/newsletter/subscribers/not-an-object-id`, { method: "DELETE", headers: { Origin: superSession.origin, Cookie: superSession.cookie, "X-CSRF-Token": superSession.csrfToken } });
  assert.equal(invalid.status, 400);
});

test("article list permission returns summaries while details require view or edit permission", async () => {
  const admin = await Admin.create({ name: "Synthetic Publisher", email: "publisher@example.invalid", passwordHash: await hashPassword("Synthetic-Publisher-Password-92!"), role: "admin", permissions: ["publishing:articles:list"] });
  const article = await Article.create({ contentType: "blog", title: "Permission projection", slug: `permission-${randomUUID()}`, summary: "Summary only", body: "Private detail content", category: "Operations", tags: ["synthetic"], status: "draft", announcementStatus: "not_eligible", createdBy: admin._id, updatedBy: admin._id });
  const origin = "http://localhost:5174";
  const csrfResponse = await fetch(`${api}/api/admin/auth/csrf`, { headers: { Origin: origin } });
  assert.equal(csrfResponse.status, 200);
  const cookie = csrfResponse.headers.get("set-cookie").split(";")[0];
  const { csrfToken } = await csrfResponse.json();
  const loginResponse = await fetch(`${api}/api/admin/auth/login`, { method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ email: admin.email, password: "Synthetic-Publisher-Password-92!" }) });
  assert.equal(loginResponse.status, 200);
  const sessionCookie = loginResponse.headers.get("set-cookie").split(";")[0];
  const loginBody = await loginResponse.json();
  const listResponse = await fetch(`${api}/api/admin/articles`, { headers: { Cookie: sessionCookie } });
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  const listed = list.items.find((item) => item._id === String(article._id));
  assert.ok(listed);
  assert.equal("body" in listed, false);
  assert.equal("tags" in listed, false);
  assert.equal(listed.announcementStatus, "not_eligible", "summary permissions include the publication and announcement status needed by the list UI");
  const filtered = await (await fetch(`${api}/api/admin/articles?category=Operations&status=draft`, { headers: { Cookie: sessionCookie } })).json();
  assert.ok(filtered.items.some((item) => item._id === String(article._id)));
  assert.ok(filtered.items.every((item) => item.category === "Operations" && item.status === "draft"));
  const detailResponse = await fetch(`${api}/api/admin/articles/${article._id}`, { headers: { Cookie: sessionCookie } });
  assert.equal(detailResponse.status, 403);
  await Admin.updateOne({ _id: admin._id }, { $set: { permissions: ["publishing:articles:list", "publishing:articles:edit", "publishing:articles:schedule", "publishing:articles:uploadImage", "publishing:articles:publish", "publishing:articles:create"] } });
  const detailAllowed = await fetch(`${api}/api/admin/articles/${article._id}`, { headers: { Cookie: sessionCookie } });
  assert.equal(detailAllowed.status, 200);
  const uploadedAssets = [];
  for (const [width, height] of [[160, 80], [80, 160], [100, 100]]) {
    const bytes = syntheticPng(width, height);
    assert.equal(bytes.readUInt32BE(16), width);
    assert.equal(bytes.readUInt32BE(20), height);
    const imageForm = new FormData();
    imageForm.append("image", new Blob([bytes], { type: "image/png" }), `synthetic-${width}x${height}.png`);
    const imageResponse = await fetch(`${api}/api/admin/articles/image`, { method: "POST", headers: { Origin: origin, Cookie: sessionCookie, "X-CSRF-Token": loginBody.csrfToken }, body: imageForm });
    assert.equal(imageResponse.status, 201);
    const item = (await imageResponse.json()).item;
    assert.match(item.mediaId, /^[a-f\d]{24}$/i, "successful upload returns its stable GridFS id");
    const gridfs = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "media" });
    const [gridfsFile] = await gridfs.find({ _id: new mongoose.Types.ObjectId(item.mediaId) }).toArray();
    assert.ok(gridfsFile, "the uploaded binary has a GridFS file record");
    assert.equal(gridfsFile.metadata.originalFilename, `synthetic-${width}x${height}.png`);
    assert.equal(gridfsFile.length, bytes.length);
    uploadedAssets.push({ item, bytes, width, height });
  }
  const { item: uploadedImage, bytes: imageBytes } = uploadedAssets[0];
  const unlinkedImageResponse = await fetch(`${api}/api/media/${uploadedImage.mediaId}`);
  assert.equal(unlinkedImageResponse.status, 404, "a GridFS image is not public until published content or a retained campaign references it");
  const gridfs = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "media" });
  const storedBeforeRetry = await gridfs.find({}).toArray();
  const retryForm = new FormData();
  retryForm.append("image", new Blob([imageBytes], { type: "image/png" }), "synthetic-retry.png");
  const retryUpload = await fetch(`${api}/api/admin/articles/image`, { method: "POST", headers: { Origin: origin, Cookie: sessionCookie, "X-CSRF-Token": loginBody.csrfToken }, body: retryForm });
  assert.equal(retryUpload.status, 201);
  assert.equal((await retryUpload.json()).item.mediaId, uploadedImage.mediaId, "re-uploading identical content reuses its stable GridFS record");
  assert.equal((await gridfs.find({}).toArray()).length, storedBeforeRetry.length, "an identical retry does not create another GridFS file");
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  const jpegForm = new FormData();
  jpegForm.append("image", new Blob([jpegBytes], { type: "image/jpeg" }), "synthetic.jpeg");
  const jpegUpload = await fetch(`${api}/api/admin/articles/image`, { method: "POST", headers: { Origin: origin, Cookie: sessionCookie, "X-CSRF-Token": loginBody.csrfToken }, body: jpegForm });
  assert.equal(jpegUpload.status, 201, "the existing JPEG format supports both .jpg and .jpeg filename extensions");
  const jpegItem = (await jpegUpload.json()).item;
  assert.equal(jpegItem.originalFilename, "synthetic.jpeg");
  const jpegGridFsFile = await gridfs.find({ _id: new mongoose.Types.ObjectId(jpegItem.mediaId) }).toArray();
  assert.equal(jpegGridFsFile[0]?.metadata.mimeType, "image/jpeg");
  const unauthenticatedImagePreview = await fetch(`${api}/api/admin/assets/${uploadedImage.filename}`);
  assert.equal(unauthenticatedImagePreview.status, 401, "admin article previews remain private without a session");
  const imageRecords = uploadedAssets.map(({ item, width, height }) => ({ ...item, alt: `Synthetic ${width} by ${height} image` }));
  const { url: uploadedImageUrl, ...imageRecord } = imageRecords[0];
  const imageArticlePayload = { contentType: "news", title: "Synthetic image persistence article", slug: `synthetic-image-${randomUUID()}`, summary: "An isolated image lifecycle check", body: "Synthetic article body", category: "Synthetic tests", images: imageRecords.map(({ url, ...image }) => image), thumbnailFilename: uploadedImage.filename, status: "published" };
  const imageArticleResponse = await fetch(`${api}/api/admin/articles`, { method: "POST", headers: { Origin: origin, Cookie: sessionCookie, "Content-Type": "application/json", "X-CSRF-Token": loginBody.csrfToken }, body: JSON.stringify(imageArticlePayload) });
  assert.equal(imageArticleResponse.status, 201, JSON.stringify(await imageArticleResponse.clone().json()));
  const imageArticle = (await imageArticleResponse.json()).item;
  const persistedImageArticle = await Article.findById(imageArticle._id).lean();
  assert.equal(persistedImageArticle.thumbnailFilename, uploadedImage.filename);
  assert.equal(persistedImageArticle.images.length, 3);
  assert.equal(String(persistedImageArticle.images[0].mediaId), uploadedImage.mediaId);
  assert.equal(persistedImageArticle.images[0].originalFilename, "synthetic-160x80.png");
  assert.deepEqual(persistedImageArticle.images.map((image) => image.size), uploadedAssets.map(({ bytes }) => bytes.length));
  assert.deepEqual(persistedImageArticle.images.map((image) => image.filename), uploadedAssets.map(({ item }) => item.filename));
  const publicImageList = await (await fetch(`${api}/api/news?search=${encodeURIComponent(imageArticle.title)}`)).json();
  assert.equal(publicImageList.items.length, 1);
  assert.equal(publicImageList.items[0].thumbnailFilename, uploadedImage.filename);
  assert.equal(publicImageList.items[0].thumbnailMediaId, uploadedImage.mediaId);
  assert.equal(publicImageList.items[0].thumbnailUrl, `/api/media/${uploadedImage.mediaId}`);
  assert.equal(publicImageList.items[0].images[0].filename, uploadedImage.filename);
  assert.equal(publicImageList.items[0].images[0].url, `/api/media/${uploadedImage.mediaId}`);
  assert.deepEqual(publicImageList.items[0].images.map((image) => image.alt), uploadedAssets.map(({ width, height }) => `Synthetic ${width} by ${height} image`));
  const typedImageList = await (await fetch(`${api}/api/news/news?search=${encodeURIComponent(imageArticle.title)}`)).json();
  assert.equal(typedImageList.items.length, 1);
  assert.equal(typedImageList.items[0].thumbnailUrl, `/api/media/${uploadedImage.mediaId}`);
  assert.equal(typedImageList.items[0].images[0].url, `/api/media/${uploadedImage.mediaId}`, "the legacy typed list includes the saved media ID needed by the public renderer");
  const publicImageDetail = await (await fetch(`${api}/api/news/news/${imageArticle.slug}`)).json();
  assert.equal(publicImageDetail.item.thumbnailFilename, uploadedImage.filename);
  assert.equal(publicImageDetail.item.thumbnailUrl, `/api/media/${uploadedImage.mediaId}`);
  assert.equal(publicImageDetail.item.images[0].filename, uploadedImage.filename);
  assert.equal(publicImageDetail.item.images.length, 3, "the full saved landscape, portrait, and square gallery remains available in detail data");
  const previousNodeEnvironment = process.env.NODE_ENV;
  const previousPublicApiOrigin = process.env.PUBLIC_API_ORIGIN;
  process.env.NODE_ENV = "production";
  process.env.PUBLIC_API_ORIGIN = "https://publishing-api.example.invalid";
  try {
    const productionList = await (await fetch(`${api}/api/news?search=${encodeURIComponent(imageArticle.title)}`)).json();
    assert.equal(productionList.items[0].thumbnailUrl, `https://publishing-api.example.invalid/api/media/${uploadedImage.mediaId}`);
    assert.doesNotMatch(productionList.items[0].thumbnailUrl, /localhost/i);
    process.env.PUBLIC_API_ORIGIN = "http://localhost:5000";
    const productionWithoutLocalOrigin = await (await fetch(`${api}/api/news?search=${encodeURIComponent(imageArticle.title)}`)).json();
    assert.equal(productionWithoutLocalOrigin.items[0].thumbnailUrl, `/api/media/${uploadedImage.mediaId}`, "a localhost API origin never leaks into a production public response");
  } finally {
    process.env.NODE_ENV = previousNodeEnvironment;
    if (previousPublicApiOrigin === undefined) delete process.env.PUBLIC_API_ORIGIN;
    else process.env.PUBLIC_API_ORIGIN = previousPublicApiOrigin;
  }
  const adminImagePreview = await fetch(`${api}/api/admin/assets/${uploadedImage.mediaId}`, { headers: { Cookie: sessionCookie } });
  assert.equal(adminImagePreview.status, 200, "article editors can load saved previews with edit permission");
  assert.equal(adminImagePreview.headers.get("content-type"), "image/png");
  assert.equal(adminImagePreview.headers.get("cross-origin-resource-policy"), "same-origin", "private article previews retain Helmet's restrictive resource policy");
  assert.deepEqual(Buffer.from(await adminImagePreview.arrayBuffer()), imageBytes);
  await Article.updateOne({ _id: article._id }, { $set: { status: "published", publishedAt: new Date(), thumbnailFilename: uploadedImage.filename, images: [imageRecord] } });
  const publicImageResponse = await fetch(`${api}${uploadedImageUrl}`);
  assert.equal(publicImageResponse.status, 200);
  assert.equal(publicImageResponse.headers.get("content-type"), "image/png");
  assert.equal(publicImageResponse.headers.get("cross-origin-resource-policy"), "cross-origin", "published GridFS article images may be embedded by the public website");
  assert.deepEqual(Buffer.from(await publicImageResponse.arrayBuffer()), imageBytes, "public article image URLs resolve to the uploaded bytes");
  for (let index = 0; index < uploadedAssets.length; index += 1) {
    const { item, bytes } = uploadedAssets[index];
    const assetResponse = await fetch(`${api}/api/media/${item.mediaId}`);
    assert.equal(assetResponse.status, 200);
    assert.equal(assetResponse.headers.get("content-type"), "image/png");
    assert.equal(assetResponse.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.deepEqual(Buffer.from(await assetResponse.arrayBuffer()), bytes, `the ${item.filename} route returns original image bytes`);
  }
  const previousCampaignApiOrigin = process.env.PUBLIC_API_ORIGIN;
  process.env.PUBLIC_API_ORIGIN = api;
  try {
    await Article.updateOne({ _id: imageArticle._id }, { $set: { announcementStatus: "queued" } });
    const campaign = await queuePublication({ type: "news", source: await Article.findById(imageArticle._id), uniqueKey: `image-email:${randomUUID()}` });
    assert.equal(campaign.imageMediaId.toString(), uploadedImage.mediaId, "queued campaign preserves the exact GridFS cover id");
    assert.equal(campaign.imageSnapshot, `/api/media/${uploadedImage.mediaId}`, "queued campaign stores a stable media path without local hostname");
    campaign.recipientsMaterialized = true;
    campaign.eligibleCount = 1;
    await campaign.save();
    const campaignSubscriber = await Subscriber.create({ email: "image-campaign@example.invalid", status: "active", confirmedAt: new Date(), consent: { source: "website-footer", acceptedAt: new Date() } });
    await Delivery.create({ campaignId: campaign._id, subscriberId: campaignSubscriber._id });
    await processWorker(new Date(Date.now() + 5_000));
    const email = emailMessages.findLast((message) => message.to === campaignSubscriber.email);
    assert.ok(email, "email delivery was captured by the isolated transport stub");
    const imageSrc = email.html.match(/<img[^>]+src="([^"]+)"/i)?.[1];
    assert.equal(imageSrc, `${api}/api/media/${uploadedImage.mediaId}`);
    assert.doesNotMatch(imageSrc, /localhost/i);
    assert.match(email.html, /width:100%;max-width:100%;height:auto/);
    const emailAsset = await fetch(imageSrc);
    assert.equal(emailAsset.status, 200);
    assert.equal(emailAsset.headers.get("content-type"), "image/png");
    assert.equal(emailAsset.headers.get("cross-origin-resource-policy"), "cross-origin", "the exact newsletter image URL is embeddable by cross-origin email clients");
    assert.deepEqual(Buffer.from(await emailAsset.arrayBuffer()), imageBytes, "the URL embedded in generated campaign HTML returns original image bytes");
    await Article.updateOne({ _id: imageArticle._id }, { $set: { status: "unpublished" } });
    const historicalCampaignImage = await fetch(imageSrc);
    assert.equal(historicalCampaignImage.status, 200, "published campaign media remains retrievable after the source article is later unpublished");
    assert.deepEqual(Buffer.from(await historicalCampaignImage.arrayBuffer()), imageBytes);
  } finally {
    if (previousCampaignApiOrigin === undefined) delete process.env.PUBLIC_API_ORIGIN;
    else process.env.PUBLIC_API_ORIGIN = previousCampaignApiOrigin;
  }
  const missingImageResponse = await fetch(`${api}/api/news/assets/${randomUUID()}.jpg`);
  assert.equal(missingImageResponse.status, 404);
  assert.match(missingImageResponse.headers.get("content-type"), /^text\/plain/);
  const missingGridFsResponse = await fetch(`${api}/api/media/ffffffffffffffffffffffff`);
  assert.equal(missingGridFsResponse.status, 404, "a valid but absent GridFS id returns a real not-found response");
  assert.match(missingGridFsResponse.headers.get("content-type"), /^text\/plain/);
  const legacyFilename = `${randomUUID()}.png`;
  const legacyBytes = syntheticPng(40, 20);
  await fs.mkdir(path.join(TEST_UPLOADS, "publishing"), { recursive: true });
  await fs.writeFile(path.join(TEST_UPLOADS, "publishing", legacyFilename), legacyBytes);
  await Article.create({ contentType: "news", title: "Legacy filesystem image remains readable", slug: `legacy-image-${randomUUID()}`, summary: "Preserved old reference", body: "Synthetic legacy article", images: [{ filename: legacyFilename, mimeType: "image/png", size: legacyBytes.length, alt: "Legacy image" }], thumbnailFilename: legacyFilename, status: "published", publishedAt: new Date(), createdBy: admin._id, updatedBy: admin._id });
  const legacyResponse = await fetch(`${api}/api/news/assets/${legacyFilename}`);
  assert.equal(legacyResponse.status, 200, "old filesystem-backed article references keep working during the transition");
  assert.equal(legacyResponse.headers.get("content-type"), "image/png");
  assert.equal(legacyResponse.headers.get("cross-origin-resource-policy"), "cross-origin", "legacy public article images may be embedded cross-origin");
  assert.deepEqual(Buffer.from(await legacyResponse.arrayBuffer()), legacyBytes);
  const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const scheduleResponse = await fetch(`${api}/api/admin/articles/${article._id}/state`, { method: "PATCH", headers: { Origin: origin, Cookie: sessionCookie, "Content-Type": "application/json", "X-CSRF-Token": loginBody.csrfToken }, body: JSON.stringify({ action: "schedule", scheduledAt, timezone: "Europe/Paris" }) });
  assert.equal(scheduleResponse.status, 200, JSON.stringify(await scheduleResponse.clone().json()));
  assert.equal((await Article.findById(article._id)).timezone, "Europe/Paris");
  const updateResponse = await fetch(`${api}/api/admin/articles/${article._id}`, { method: "PATCH", headers: { Origin: origin, Cookie: sessionCookie, "Content-Type": "application/json", "X-CSRF-Token": loginBody.csrfToken }, body: JSON.stringify({ title: article.title, slug: article.slug, summary: article.summary, body: article.body, category: article.category, tags: article.tags, author: article.author, seo: article.seo, images: [], thumbnailFilename: null }) });
  assert.equal(updateResponse.status, 200, JSON.stringify(await updateResponse.clone().json()));
  const updated = await Article.findById(article._id);
  assert.equal(updated.timezone, "Europe/Paris");
  assert.equal(updated.scheduledAt.toISOString(), scheduledAt);
});
