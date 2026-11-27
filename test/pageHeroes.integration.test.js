import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import test, { after, before } from "node:test";

const TEST_DATABASE = "projenius_page_heroes_test";
const ADMIN_ORIGIN = "http://localhost:5174";

let memoryServer;
let server;
let api;
let Admin;
let PageHero;
let hashPassword;

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
    throw new Error("Page hero tests require credential-free loopback MongoDB only.");
  }
  process.env.MONGODB_URI = uri;
  const { connectDatabase } = await import("../src/config/database.js");
  await connectDatabase();
  ({ default: Admin } = await import("../src/modules/admin/auth/admin.model.js"));
  ({ default: PageHero } = await import("../src/modules/pageheroes/pageHero.model.js"));
  ({ hashPassword } = await import("../src/modules/admin/auth/auth.service.js"));
  await Promise.all([Admin, PageHero].map((Model) => Model.createIndexes()));

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

function save(session, key, body) {
  return fetch(`${api}/api/page-heroes/admin/${key}`, { method: "PUT", headers: json(session), body: JSON.stringify(body) });
}

async function upload(session, key, field, buffer, name = "hero.webp", type = "image/webp") {
  const form = new FormData();
  form.append("image", new Blob([buffer], { type }), name);
  return fetch(`${api}/api/page-heroes/admin/${key}/image?field=${encodeURIComponent(field)}`, { method: "POST", headers: { Origin: ADMIN_ORIGIN, Cookie: session.cookie, "X-CSRF-Token": session.csrfToken }, body: form });
}


const card = (index) => ({ image: { source: "default" }, alt: `Synthetic card photo number ${index}`, category: "Recognition", title: `Card title ${index}` });
const aboutValues = () => ({
  eyebrow: "",
  title: "Technology. Innovation.",
  accent: ["Real-World Impact.", "Built in Madurai."],
  description: "A multidisciplinary organization in Madurai, bringing technology, learning and innovation together.",
  primary: { label: "Talk to Our Team", to: "/contact" },
  secondary: { label: "Our Journey", to: "#about-journey" },
  cards: [1, 2, 3, 4, 5].map(card),
});

test("page heroes: schema-checked saves, WebP images, conflicts and reset", async () => {
  assert.equal((await fetch(`${api}/api/page-heroes/hardware-embedded-systems`)).status, 404, "excluded pages have no editable hero");
  assert.equal((await (await fetch(`${api}/api/page-heroes/about`)).json()).item, null);
  assert.equal((await fetch(`${api}/api/page-heroes/admin`)).status, 401);

  const viewer = await createAdmin("admin", ["pages:heroes:view"]);
  const editor = await createAdmin("admin", ["pages:heroes:view", "pages:heroes:edit"]);
  const list = await (await fetch(`${api}/api/page-heroes/admin`, { headers: { Cookie: viewer.cookie } })).json();
  assert.deepEqual(list.items.map((item) => item.key), ["about", "software-development", "pcb-design-fabrication", "courses", "career-guidance", "workshops", "products", "news-insights", "join-our-team"]);
  const start = await (await fetch(`${api}/api/page-heroes/admin/about`, { headers: { Cookie: viewer.cookie } })).json();
  assert.equal(start.item.revision, 0);
  assert.ok(start.schema.fields.some((field) => field.name === "cards" && field.count.min === 5));

  assert.equal((await save(viewer, "about", { revision: 0, values: aboutValues() })).status, 403);

  const extra = { ...aboutValues(), html: "<script>" };
  assert.match((await (await save(editor, "about", { revision: 0, values: extra })).json()).error, /not a field/);
  const long = aboutValues(); long.title = "x".repeat(27);
  assert.match((await (await save(editor, "about", { revision: 0, values: long })).json()).error, /Heading \(white\) must be 3–26/);
  const fourCards = aboutValues(); fourCards.cards.pop();
  assert.equal((await save(editor, "about", { revision: 0, values: fourCards })).status, 400);
  const badLink = aboutValues(); badLink.primary.to = "https://evil.example";
  assert.equal((await save(editor, "about", { revision: 0, values: badLink })).status, 400);

  assert.match((await (await upload(editor, "about", "cards.image", png(1200, 1000), "card.png", "image/png")).json()).error, /WebP/);
  assert.match((await (await upload(editor, "about", "cards.image", webp(600, 500))).json()).error, /at least 800 × 680/);
  assert.equal((await upload(editor, "about", "title", webp(1200, 1000))).status, 400, "only image fields take uploads");
  const uploaded = await upload(editor, "about", "cards.image", webp(1200, 1000));
  assert.equal(uploaded.status, 201);
  const { mediaId } = (await uploaded.json()).item;

  // A card photo cannot be used where a full-screen backdrop is needed.
  const software = await (await fetch(`${api}/api/page-heroes/admin/software-development`, { headers: { Cookie: viewer.cookie } })).json();
  assert.ok(software.schema.fields.some((field) => field.name === "backdrop"));

  const values = aboutValues();
  values.title = "  Technology.   Innovation. ";
  values.cards[0].image = { source: "upload", mediaId };
  const saved = await save(editor, "about", { revision: 0, values });
  assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
  const savedBody = await saved.json();
  assert.equal(savedBody.item.revision, 1);
  assert.equal(savedBody.item.values.title, "Technology. Innovation.");
  assert.equal(savedBody.item.values.cards[0].image.width, 1200);

  assert.equal((await save(editor, "about", { revision: 0, values: aboutValues() })).status, 409, "stale revision");

  const live = await (await fetch(`${api}/api/page-heroes/about`)).json();
  assert.equal(live.item.values.cards[0].image.url, `/api/media/${mediaId}`);
  assert.equal(live.item.values.cards[1].image.source, "default");
  assert.equal((await fetch(`${api}/api/media/${mediaId}`)).status, 200, "a saved hero image is public");

  const reset = await fetch(`${api}/api/page-heroes/admin/about`, { method: "DELETE", headers: json(editor), body: JSON.stringify({ revision: 1 }) });
  assert.equal(reset.status, 200);
  assert.equal((await (await fetch(`${api}/api/page-heroes/about`)).json()).item, null, "reset returns to the website default");
  assert.equal((await fetch(`${api}/api/media/${mediaId}`)).status, 404, "its image is no longer public");
});
