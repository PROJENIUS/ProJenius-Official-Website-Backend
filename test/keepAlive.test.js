import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";
import mongoose from "mongoose";
import { connectDatabase } from "../src/config/database.js";

/* Keep-alive: writes one "ProJenius" entry every 15 days into its own
   collection, never into enquiries; the outside-cron URL needs the token. */

const DB = "projenius_keepalive_test";
let memoryServer, server, base, svc, Enquiry;
const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  delete process.env.MONGODB_URI;
  process.env.NODE_ENV = "test";
  process.env.MONGOMS_RUNTIME_DOWNLOAD = "false";
  process.env.ADMIN_SITE_ORIGIN = "http://localhost:5174";
  process.env.SESSION_SECRET = randomBytes(48).toString("hex");
  process.env.KEEPALIVE_TOKEN = "test-keepalive-token-0123456789abcdef";
  const { MongoMemoryServer } = await import("mongodb-memory-server");
  memoryServer = await MongoMemoryServer.create({ instance: { dbName: DB, ip: "127.0.0.1" } });
  process.env.MONGODB_URI = memoryServer.getUri(DB);
  process.env.MONGODB_DB_NAME = DB;
  mongoose.set("autoIndex", false);
  await connectDatabase();
  if (mongoose.connection.host !== "127.0.0.1") throw new Error("Not the temporary test database.");
  svc = await import("../src/modules/keepalive/keepAlive.service.js");
  ({ default: Enquiry } = await import("../src/modules/contacts/enquiry.model.js"));
  const { default: app } = await import("../src/app.js");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}/api/keepalive`;
});

after(async () => { server?.close(); await mongoose.disconnect(); await memoryServer?.stop(); });

test("writes a ProJenius entry only when 15 days have passed, and never touches enquiries", async () => {
  const now = new Date();
  let r = await svc.runKeepAlive({ source: "scheduler", now });
  assert.equal(r.written, true);
  assert.equal(r.last.name, "ProJenius");
  r = await svc.runKeepAlive({ source: "scheduler", now: new Date(now.getTime() + 14 * DAY) });
  assert.equal(r.written, false, "not again within 15 days");
  r = await svc.runKeepAlive({ source: "scheduler", now: new Date(now.getTime() + 15 * DAY + 1000) });
  assert.equal(r.written, true, "written again after 15 days");
  assert.equal(await svc.KeepAlive.countDocuments(), 2);
  assert.equal(await Enquiry.countDocuments(), 0, "no fake enquiries are created");
});

test("outside-cron URL needs the token", async () => {
  let res = await fetch(base);
  assert.equal(res.status, 401);
  res = await fetch(`${base}?token=wrong`);
  assert.equal(res.status, 401);
  res = await fetch(base, { headers: { "X-Keepalive-Token": process.env.KEEPALIVE_TOKEN } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.lastEntryAt);
});
