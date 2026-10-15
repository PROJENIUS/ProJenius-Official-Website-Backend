import Razorpay from "razorpay";
import crypto from "node:crypto";

let cachedCredentialFingerprint;
let cachedClient;

export function getRazorpayClient() {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!/^rzp_(?:test|live)_[A-Za-z0-9]+$/.test(keyId || "") || !keySecret) return null;
  const credentialFingerprint = crypto.createHash("sha256").update(`${keyId}\0${keySecret}`).digest("hex");
  if (!cachedClient || cachedCredentialFingerprint !== credentialFingerprint) {
    cachedCredentialFingerprint = credentialFingerprint;
    cachedClient = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }
  return { keyId, client: cachedClient };
}

export function verifyPaymentSignature(orderId, paymentId, signature) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !orderId || !paymentId || !/^[a-f\d]{64}$/i.test(signature || "")) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
}

export function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !Buffer.isBuffer(rawBody) || !/^[a-f\d]{64}$/i.test(signature || "")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
}
