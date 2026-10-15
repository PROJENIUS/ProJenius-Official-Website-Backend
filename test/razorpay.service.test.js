import test from "node:test";
import assert from "node:assert/strict";
import { getRazorpayClient, verifyWebhookSignature } from "../src/shared/payments/razorpay.service.js";

const originalKeyId = process.env.RAZORPAY_KEY_ID;
const originalKeySecret = process.env.RAZORPAY_KEY_SECRET;
const originalWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
test.after(() => {
  if (originalKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
  else process.env.RAZORPAY_KEY_ID = originalKeyId;
  if (originalKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
  else process.env.RAZORPAY_KEY_SECRET = originalKeySecret;
  if (originalWebhookSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
  else process.env.RAZORPAY_WEBHOOK_SECRET = originalWebhookSecret;
});

test("payment client fails closed for missing or malformed API configuration", () => {
  process.env.RAZORPAY_KEY_ID = "rzp_live_syntheticKey123";
  process.env.RAZORPAY_KEY_SECRET = "synthetic_secret_value";
  assert.ok(getRazorpayClient());

  delete process.env.RAZORPAY_KEY_ID;
  assert.equal(getRazorpayClient(), null);
  process.env.RAZORPAY_KEY_ID = "not-a-razorpay-key";
  assert.equal(getRazorpayClient(), null);
  process.env.RAZORPAY_KEY_ID = "rzp_test_syntheticKey456";
  delete process.env.RAZORPAY_KEY_SECRET;
  assert.equal(getRazorpayClient(), null);
});

test("Razorpay client cache refreshes when the API secret changes", () => {
  process.env.RAZORPAY_KEY_ID = "rzp_test_cacheRotation123";
  process.env.RAZORPAY_KEY_SECRET = "synthetic_secret_first";
  const first = getRazorpayClient();
  process.env.RAZORPAY_KEY_SECRET = "synthetic_secret_second";
  const second = getRazorpayClient();
  assert.notEqual(first.client, second.client);
});

test("webhook verification rejects a missing webhook secret", () => {
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  assert.equal(verifyWebhookSignature(Buffer.from("synthetic payload"), "a".repeat(64)), false);
});

test("webhook endpoint fails closed and logs only a safe missing-secret diagnostic", async () => {
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  const { razorpayWebhook } = await import("../src/modules/courses/courses.controller.js");
  const warnings = [];
  const originalWarn = console.warn;
  let responseStatus;
  console.warn = (...parts) => warnings.push(parts.join(" "));
  try {
    await razorpayWebhook({ get: () => "", body: Buffer.from("synthetic unsigned event") }, { sendStatus: (status) => { responseStatus = status; return status; } });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(responseStatus, 503);
  assert.deepEqual(warnings, ["Razorpay webhook rejected: webhook secret is not configured."]);
});
