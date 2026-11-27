import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import test, { after, before } from "node:test";

const TEST_DATABASE = "projenius_home_hero_test";
const ADMIN_ORIGIN = "http://localhost:5174";

let memoryServer;
let server;
let api;
let Admin;
let HomeHero;
let hashPassword;
let imageDimensions;

/* A PNG header with the given size (enough for type and size checks). */
function png(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header.writeUInt8(8, 24);
  header.writeUInt8(2, 25);
  // A unique tail keeps each test image a separate stored file.
  return Buffer.concat([header, randomBytes(16), Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])]);
}

/* A WebP (VP8X) header with the given size. */
function webp(width, height) {
  const header = Buffer.alloc(30);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(22 + 16, 4);
  header.write("WEBP", 8, "ascii");
  header.write("VP8X", 12, "ascii");
  header.writeUInt32LE(10, 16);
  header.writeUIntLE(width - 1, 24, 3);
  header.writeUIntLE(height - 1, 27, 3);
  return Buffer.concat([header, randomBytes(16)]);
}

/* A JPEG with an EXIF "rotate 90°" tag: the shown size is height × width. */
function rotatedJpeg(width, height) {
  const exif = Buffer.alloc(8 + 2 + 12 + 4);
  exif.write("II", 0, "ascii");
  exif.writeUInt16LE(42, 2);
  exif.writeUInt32LE(8, 4);
  exif.writeUInt16LE(1, 8);
  exif.writeUInt16LE(0x0112, 10);
  exif.writeUInt16LE(3, 12);
  exif.writeUInt32LE(1, 14);
  exif.writeUInt16LE(6, 18);
  const app1Body = Buffer.concat([Buffer.from("Exif\0\0", "binary"), exif]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(app1Body.length + 2) >> 8, (app1Body.length + 2) & 255]), app1Body]);
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xd9])]);
}

before(async () => {
  delete process.env.MONGODB_URI;
  process.env.NODE_ENV = "test";
  process.env.MONGOMS_RUNTIME_DOWNLOAD = "false";
  process.env.ADMIN_SITE_ORIGIN = ADMIN_ORIGIN;
  process.env.PUBLIC_SITE_ORIGIN = "http://localhost:5173";
  process.env.SESSION_SECRET = randomBytes(48).toString("hex");

  const { MongoMemoryServer } = await import("mongodb-memory-server");
  memoryServer = await MongoMemoryServer.create({ instance: { dbName: TEST_DATABASE, ip: "127.0.0.1" } });
  const uri = memoryServer.getUri(TEST_DATABASE);
  const parsed = new URL(uri);
  if (parsed.protocol !== "mongodb:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password) {
    throw new Error("Home Hero tests require credential-free loopback MongoDB only.");
  }
  process.env.MONGODB_URI = uri;
  const { connectDatabase } = await import("../src/config/database.js");
  await connectDatabase();
  ({ default: Admin } = await import("../src/modules/admin/auth/admin.model.js"));
  ({ default: HomeHero } = await import("../src/modules/homepage/homeHero.model.js"));
  ({ hashPassword } = await import("../src/modules/admin/auth/auth.service.js"));
  ({ imageDimensions } = await import("../src/shared/media/imageDimensions.js"));
  await Promise.all([Admin, HomeHero].map((Model) => Model.createIndexes()));

  const { default: app } = await import("../src/app.js");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  api = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  const mongoose = (await import("mongoose")).default;
  await mongoose.disconnect();
  await memoryServer?.stop();
  delete process.env.MONGODB_URI;
});

async function createAdmin(role, permissions) {
  const password = `Synthetic-Hero-${randomUUID()}-9!`;
  const admin = await Admin.create({ name: `Synthetic ${role}`, email: `hero-${randomUUID()}@example.invalid`, passwordHash: await hashPassword(password), role, permissions });
  return login(admin, password);
}

async function login(admin, password) {
  const tokenResponse = await fetch(`${api}/api/admin/auth/csrf`, { headers: { Origin: ADMIN_ORIGIN } });
  const cookie = tokenResponse.headers.get("set-cookie").split(";")[0];
  const { csrfToken } = await tokenResponse.json();
  const response = await fetch(`${api}/api/admin/auth/login`, {
    method: "POST",
    headers: { Origin: ADMIN_ORIGIN, Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ email: admin.email, password }),
  });
  assert.equal(response.status, 200);
  return { cookie: response.headers.get("set-cookie").split(";")[0], csrfToken: (await response.json()).csrfToken };
}

const json = (session) => ({ Origin: ADMIN_ORIGIN, Cookie: session.cookie, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" });

function save(session, body) {
  return fetch(`${api}/api/home/admin/hero`, { method: "PUT", headers: json(session), body: JSON.stringify(body) });
}

async function upload(session, buffer, name = "hero.webp", type = "image/webp") {
  const form = new FormData();
  form.append("image", new Blob([buffer], { type }), name);
  return fetch(`${api}/api/home/admin/hero/image`, { method: "POST", headers: { Origin: ADMIN_ORIGIN, Cookie: session.cookie, "X-CSRF-Token": session.csrfToken }, body: form });
}

test("image headers give the size the browser shows", () => {
  assert.deepEqual(imageDimensions(png(1920, 1200), "image/png"), { width: 1920, height: 1200 });
  assert.deepEqual(imageDimensions(webp(1920, 1200), "image/webp"), { width: 1920, height: 1200 });
  assert.deepEqual(imageDimensions(rotatedJpeg(1200, 1920), "image/jpeg"), { width: 1920, height: 1200 }, "EXIF rotation swaps width and height");
  assert.equal(imageDimensions(Buffer.from("not an image"), "image/png"), null);
});

test("Home Hero: permissions, validation, images, conflicts and public output", async () => {
  // Nothing saved yet: the website keeps its built-in slides.
  const empty = await (await fetch(`${api}/api/home/hero`)).json();
  assert.equal(empty.item, null);

  const anonymous = await fetch(`${api}/api/home/admin/hero`);
  assert.equal(anonymous.status, 401);

  const viewer = await createAdmin("admin", ["home:hero:view"]);
  const outsider = await createAdmin("admin", ["dashboard:view"]);
  const editor = await createAdmin("admin", ["home:hero:view", "home:hero:edit"]);

  assert.equal((await fetch(`${api}/api/home/admin/hero`, { headers: { Cookie: outsider.cookie } })).status, 403);
  const start = await (await fetch(`${api}/api/home/admin/hero`, { headers: { Cookie: viewer.cookie } })).json();
  assert.equal(start.item.isDefault, true);
  assert.equal(start.item.revision, 0);
  assert.equal(start.item.slides.length, 5);
  assert.equal(start.rules.slides.max, 10);
  assert.equal(start.linksSource, "built-in");
  assert.equal("builtinImages" in start, false);
  assert.ok(start.links.some((link) => link.to === "/services/courses#course-catalog"));

  const slides = start.item.slides;
  assert.equal((await save(viewer, { revision: 0, slides })).status, 403, "view permission cannot save");

  // CSRF: a save without the token is refused.
  const noCsrf = await fetch(`${api}/api/home/admin/hero`, { method: "PUT", headers: { Origin: ADMIN_ORIGIN, Cookie: editor.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ revision: 0, slides }) });
  assert.equal(noCsrf.status, 403);

  // Content rules.
  const tooLong = structuredClone(slides);
  tooLong[0].highlight = "x".repeat(26);
  const tooLongResponse = await save(editor, { revision: 0, slides: tooLong });
  assert.equal(tooLongResponse.status, 400);
  assert.match((await tooLongResponse.json()).error, /Slide 1: Heading highlight \(blue\) must be 3–25/);

  for (const to of ["https://evil.example", "//evil.example", "javascript:alert(1)", "/path with space"]) {
    const badLink = structuredClone(slides);
    badLink[1].primary.to = to;
    assert.equal((await save(editor, { revision: 0, slides: badLink })).status, 400, `rejects link ${to}`);
  }

  const extraField = structuredClone(slides);
  extraField[0].html = "<script>";
  assert.equal((await save(editor, { revision: 0, slides: extraField })).status, 400);

  const tooFewVisible = structuredClone(slides).map((slide, index) => ({ ...slide, isVisible: index < 2 }));
  assert.match((await (await save(editor, { revision: 0, slides: tooFewVisible })).json()).error, /at least 3/);

  const eleven = [...structuredClone(slides), ...Array.from({ length: 6 }, (_, index) => ({ ...structuredClone(slides[0]), key: `extra-${index}` }))];
  assert.equal((await save(editor, { revision: 0, slides: eleven })).status, 400, "at most 10 slides");

  // Image rules: real size from the file, not from the request.
  assert.match((await (await upload(editor, png(1920, 1200), "hero.png", "image/png")).json()).error, /WebP/, "new Home Hero images must be WebP");
  assert.equal((await upload(editor, webp(1200, 800))).status, 400, "too small");
  assert.match((await (await upload(editor, webp(2400, 1000))).json()).error, /3:2 and 16:9/, "too wide");
  assert.equal((await upload(editor, Buffer.from("<svg></svg>"), "hero.svg", "image/svg+xml")).status, 400);
  assert.equal((await upload(editor, webp(1920, 1200), "hero.jpg", "image/jpeg")).status, 400, "name and bytes must agree");
  const uploaded = await upload(editor, webp(1920, 1200));
  assert.equal(uploaded.status, 201);
  const image = (await uploaded.json()).item;
  assert.deepEqual([image.width, image.height], [1920, 1200]);

  // Save: text is tidied, the upload is used, hidden slides stay out of public output.
  const edited = structuredClone(slides);
  edited[0].title = "  Ideas   Into Innovation. ";
  edited[0].image = { source: "upload", mediaId: image.mediaId };
  edited[4].isVisible = false;
  const saved = await save(editor, { revision: 0, slides: edited });
  assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
  const savedBody = await saved.json();
  assert.equal(savedBody.item.revision, 1);
  assert.equal(savedBody.item.slides[0].title, "Ideas Into Innovation.");
  assert.equal(savedBody.item.slides[0].image.width, 1920);

  // A second editor holding the old revision cannot overwrite.
  const stale = await save(editor, { revision: 0, slides });
  assert.equal(stale.status, 409);

  const publicHero = await (await fetch(`${api}/api/home/hero`)).json();
  assert.equal(publicHero.item.slides.length, 4);
  assert.equal(publicHero.item.slides[0].image.url, `/api/media/${image.mediaId}`);
  assert.equal(publicHero.item.slides[1].image.builtinKey, "hero-slide-2");
  assert.equal("isVisible" in publicHero.item.slides[0], false);

  const media = await fetch(`${api}${publicHero.item.slides[0].image.url}`);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get("content-type"), "image/webp");
  assert.equal((await fetch(`${api}/api/home/admin/hero/media/${image.mediaId}`, { headers: { Cookie: viewer.cookie } })).status, 200);

  // An image used only on a hidden slide is not public.
  const hiddenOnly = structuredClone(savedBody.item.slides).map((slide) => ({ ...slide, image: slide.image.source === "upload" ? { source: "upload", mediaId: slide.image.mediaId } : { source: "builtin", builtinKey: slide.image.builtinKey } }));
  hiddenOnly[0].isVisible = false;
  hiddenOnly[4].isVisible = true;
  const hiddenSave = await save(editor, { revision: 1, slides: hiddenOnly });
  assert.equal(hiddenSave.status, 200, JSON.stringify(await hiddenSave.clone().json()));
  assert.equal((await fetch(`${api}/api/media/${image.mediaId}`)).status, 404);
  assert.equal((await fetch(`${api}/api/home/admin/hero/media/${image.mediaId}`, { headers: { Cookie: viewer.cookie } })).status, 200, "admins can still preview it");
});

test("the admin link list comes from the website's site-links.json, safely", async () => {
  const { createServer } = await import("node:http");
  const { getHeroLinks, siteLinksInternals } = await import("../src/modules/homepage/siteLinks.service.js");
  let body = JSON.stringify({ version: 1, links: [
    { label: "Home · Our Services", to: "#home-services" },
    { label: "Brand-new page", to: "/new-page" },
    { label: "Outside", to: "https://evil.example" },
    { label: "Protocol-relative", to: "//evil.example" },
    { label: "Duplicate", to: "/new-page" },
    { label: "", to: "/no-label" },
  ] });
  const site = createServer((req, res) => {
    if (req.url !== "/site-links.json") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(body);
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const previous = process.env.PUBLIC_SITE_ORIGIN;
  process.env.PUBLIC_SITE_ORIGIN = `http://127.0.0.1:${site.address().port}`;
  process.env.SITE_LINKS_FETCH = "1";
  try {
    siteLinksInternals.reset();
    const live = await getHeroLinks();
    assert.equal(live.source, "website");
    assert.deepEqual(live.links, [{ label: "Home · Our Services", to: "#home-services" }, { label: "Brand-new page", to: "/new-page" }], "outside, duplicate and unlabelled links are dropped");

    body = "not json";
    siteLinksInternals.reset();
    const broken = await getHeroLinks();
    assert.equal(broken.source, "built-in", "a broken file falls back to the built-in list");
    assert.ok(broken.links.length > 10);
  } finally {
    delete process.env.SITE_LINKS_FETCH;
    if (previous === undefined) delete process.env.PUBLIC_SITE_ORIGIN; else process.env.PUBLIC_SITE_ORIGIN = previous;
    siteLinksInternals.reset();
    await new Promise((resolve) => site.close(resolve));
  }
});
