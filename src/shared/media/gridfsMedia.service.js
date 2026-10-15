import crypto from "node:crypto";
import mongoose from "mongoose";
import { once } from "node:events";

const BUCKET_NAME = "media";
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function bucket() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB is not connected.");
  return new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET_NAME });
}

export async function findStoredImage(mediaId) {
  if (!/^[a-f\d]{24}$/i.test(String(mediaId || ""))) return null;
  const [file] = await bucket().find({ _id: new mongoose.Types.ObjectId(mediaId) }).limit(1).toArray();
  if (!file || !ALLOWED_IMAGE_TYPES.has(file.metadata?.mimeType)) return null;
  return file;
}

async function storedBytesMatch(mediaId, checksum, expectedLength) {
  const downloadedHash = crypto.createHash("sha256");
  let downloadedLength = 0;
  for await (const chunk of bucket().openDownloadStream(new mongoose.Types.ObjectId(mediaId))) {
    downloadedHash.update(chunk);
    downloadedLength += chunk.length;
  }
  return downloadedLength === expectedLength && downloadedHash.digest("hex") === checksum;
}

export async function storeImage({ buffer, filename, originalFilename = filename, mimeType }) {
  if (!Buffer.isBuffer(buffer) || !filename || !ALLOWED_IMAGE_TYPES.has(mimeType)) throw new TypeError("Image data is invalid.");
  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
  const files = bucket();
  // Content-derived IDs make identical upload retries idempotent without an
  // unindexed collection scan or a second GridFS file.
  const mediaId = new mongoose.Types.ObjectId(checksum.slice(0, 24));
  const existing = await findStoredImage(mediaId);
  if (existing) {
    if (existing.metadata.sha256 !== checksum || existing.metadata.mimeType !== mimeType) throw new Error("Image media identifier collision detected.");
    if (existing.length === buffer.length && await storedBytesMatch(mediaId, checksum, buffer.length)) return { mediaId: String(existing._id), filename: existing.filename, originalFilename: String(originalFilename).slice(0, 255), mimeType, size: existing.length, uploadedAt: existing.uploadDate };
  }
  const upload = files.openUploadStreamWithId(mediaId, filename, {
    contentType: mimeType,
    metadata: { mimeType, originalFilename: String(originalFilename).slice(0, 255), sha256: checksum, uploadedAt: new Date() },
  });
  upload.end(buffer);
  try { await once(upload, "finish"); }
  catch (error) {
    const raced = await findStoredImage(mediaId);
    if (raced?.metadata.sha256 === checksum && raced.metadata.mimeType === mimeType && raced.length === buffer.length && await storedBytesMatch(mediaId, checksum, buffer.length)) return { mediaId: String(raced._id), filename: raced.filename, originalFilename: String(originalFilename).slice(0, 255), mimeType, size: raced.length, uploadedAt: raced.uploadDate };
    throw error;
  }
  const stored = await findStoredImage(mediaId);
  if (!stored || stored.length !== buffer.length) throw new Error("Stored image could not be verified.");
  if (!(await storedBytesMatch(mediaId, checksum, buffer.length))) throw new Error("Stored image bytes did not match the upload.");
  return { mediaId: String(mediaId), filename, originalFilename: String(originalFilename).slice(0, 255), mimeType, size: stored.length, uploadedAt: stored.uploadDate };
}

export async function streamStoredImage(mediaId, res, { cacheControl = "public, max-age=300", crossOriginResourcePolicy } = {}) {
  const file = await findStoredImage(mediaId);
  if (!file) return false;
  res.status(200).set({
    "Content-Type": file.metadata.mimeType,
    "Content-Length": String(file.length),
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    ...(crossOriginResourcePolicy ? { "Cross-Origin-Resource-Policy": crossOriginResourcePolicy } : {}),
  });
  const download = bucket().openDownloadStream(file._id);
  download.on("error", (error) => { if (!res.headersSent) res.status(404).end(); else res.destroy(error); });
  download.pipe(res);
  return true;
}

export async function storedImageExists(mediaId, { mimeType, size } = {}) {
  const file = await findStoredImage(mediaId);
  return Boolean(file && (!mimeType || file.metadata.mimeType === mimeType) && (size === undefined || file.length === size));
}

export const gridfsImageBucketName = BUCKET_NAME;
