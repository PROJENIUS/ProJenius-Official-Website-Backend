import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import test, { after, before } from "node:test";

const TEST_DATABASE = "projenius_careers_openings_test";
const ADMIN_ORIGIN = "http://localhost:5174";

let memoryServer;
let server;
let api;
let Admin;
let JobOpening;
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
    throw new Error("Careers tests require credential-free loopback MongoDB only.");
  }
  process.env.MONGODB_URI = uri;
  const { connectDatabase } = await import("../src/config/database.js");
  await connectDatabase();
  ({ default: Admin } = await import("../src/modules/admin/auth/admin.model.js"));
  ({ default: JobOpening } = await import("../src/modules/careers/jobOpening.model.js"));
  ({ hashPassword } = await import("../src/modules/admin/auth/auth.service.js"));
  await Promise.all([Admin, JobOpening].map((Model) => Model.createIndexes()));

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

const role = (over = {}) => ({
  title: "Full Stack Developer",
  department: "Software",
  employmentType: "Full-time",
  workMode: "On-site",
  location: "Madurai, Tamil Nadu",
  experience: "0–2 years",
  salary: "",
  positions: 2,
  summary: "Build web applications and dashboards for client projects and ProJenius products, from the interface to the API.",
  responsibilities: ["Build React interfaces", "Write Node.js and Express APIs", "Test and deploy live projects"],
  requirements: ["Good JavaScript basics", "Some React or Node.js practice", "Clear written English"],
  niceToHave: [],
  benefits: ["Mentoring from senior engineers"],
  skills: ["React", "Node.js"],
  status: "open",
  closesOn: "",
  ...over,
});
const send = (session, method, path, body) => fetch(`${api}/api/careers/admin/openings${path}`, { method, headers: json(session), body: body === undefined ? undefined : JSON.stringify(body) });

test("job openings: admin manages roles, the website lists only open ones", async () => {
  assert.deepEqual((await (await fetch(`${api}/api/careers/openings`)).json()).items, []);
  assert.equal((await fetch(`${api}/api/careers/admin/openings`)).status, 401);
  const viewer = await createAdmin("admin", ["careers:openings:view"]);
  const editor = await createAdmin("admin", ["careers:openings:view", "careers:openings:edit"]);

  assert.equal((await send(viewer, "POST", "", role())).status, 403);
  assert.match((await (await send(editor, "POST", "", role({ summary: "Too short" }))).json()).error, /Short summary must be 40/);
  assert.match((await (await send(editor, "POST", "", role({ responsibilities: ["One"] }))).json()).error, /What you will do/);
  assert.match((await (await send(editor, "POST", "", role({ html: "<script>" }))).json()).error, /not a job opening field/);
  assert.equal((await send(editor, "POST", "", role({ employmentType: "Freelance" }))).status, 400);

  const created = await send(editor, "POST", "", role());
  assert.equal(created.status, 201);
  const { item } = await created.json();
  assert.equal(item.slug, "full-stack-developer");
  const second = await (await send(editor, "POST", "", role({ status: "draft" }))).json();
  assert.equal(second.item.slug, "full-stack-developer-2", "same title gets its own link");

  const live = await (await fetch(`${api}/api/careers/openings`)).json();
  assert.deepEqual(live.items.map((entry) => entry.slug), ["full-stack-developer"], "drafts stay hidden");
  assert.equal((await fetch(`${api}/api/careers/openings/full-stack-developer-2`)).status, 404);
  const detail = await (await fetch(`${api}/api/careers/openings/full-stack-developer`)).json();
  assert.equal(detail.item.positions, 2);
  assert.equal("createdBy" in detail.item, false);

  const admin = await (await fetch(`${api}/api/careers/admin/openings`, { headers: { Cookie: viewer.cookie } })).json();
  const stored = admin.items.find((entry) => entry.slug === "full-stack-developer");
  assert.equal(stored.applications, 0);
  assert.ok(admin.rules.employmentTypes.includes("Internship"));

  assert.equal((await send(editor, "PUT", `/${stored.id}`, { ...role({ title: "Senior Full Stack Developer" }), updatedAt: "2000-01-01T00:00:00.000Z" })).status, 409, "stale edit");
  const full = await JobOpening.findById(stored.id).lean();
  const renamed = await (await send(editor, "PUT", `/${stored.id}`, { ...role({ title: "Senior Full Stack Developer" }), updatedAt: full.updatedAt.toISOString() })).json();
  assert.equal(renamed.item.slug, "full-stack-developer", "a published link never changes");

  assert.equal((await send(editor, "DELETE", `/${stored.id}`)).status, 400, "close before deleting");
  const afterRename = await JobOpening.findById(stored.id).lean();
  await send(editor, "PUT", `/${stored.id}`, { ...role({ status: "closed" }), updatedAt: afterRename.updatedAt.toISOString() });
  assert.deepEqual((await (await fetch(`${api}/api/careers/openings`)).json()).items, [], "closed roles disappear");
  const expired = await (await send(editor, "POST", "", role({ title: "Embedded Engineer", closesOn: "2020-01-01" }))).json();
  assert.ok(expired.item.closesOn);
  assert.deepEqual((await (await fetch(`${api}/api/careers/openings`)).json()).items, [], "past closing date disappears");
  assert.equal((await send(editor, "DELETE", `/${stored.id}`)).status, 200);
});
