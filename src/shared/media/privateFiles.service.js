/* =========================================================
   PROJENIUS BACKEND — PRIVATE FILES IN MONGODB (GridFS)
   Free hosts (Render free) wipe the local disk on every restart
   and deploy, so enquiry attachments and resumes are stored in
   MongoDB instead. Files are found by their stored name.
========================================================= */

import fs from "node:fs";
import mongoose from "mongoose";
import { pipeline } from "node:stream/promises";

const BUCKET_NAME = "private_files";

function bucket() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB is not connected.");
  return new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET_NAME });
}

const safeName = (name) => typeof name === "string" && /^[\w.-]{1,255}$/.test(name);

/* Copies an uploaded file from the temporary disk into MongoDB. */
export async function savePrivateFile(diskPath, storedName, { mimeType = "application/octet-stream", originalName = "" } = {}) {
  if (!safeName(storedName)) throw new TypeError("Invalid stored file name.");
  const upload = bucket().openUploadStream(storedName, { metadata: { mimeType, originalName: String(originalName).slice(0, 255) } });
  await pipeline(fs.createReadStream(diskPath), upload);
  return upload.id;
}

export async function findPrivateFile(storedName) {
  if (!safeName(storedName)) return null;
  const [file] = await bucket().find({ filename: storedName }).sort({ uploadDate: -1 }).limit(1).toArray();
  return file || null;
}

/* Streams a stored file as a download. Returns false when it is not in MongoDB. */
export async function sendPrivateFile(res, storedName, downloadName) {
  const file = await findPrivateFile(storedName);
  if (!file) return false;
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Type": file.metadata?.mimeType || "application/octet-stream",
    "Content-Length": String(file.length),
    "Content-Disposition": `attachment; filename="${String(downloadName || "download").replace(/["\r\n\\]/g, "_")}"`,
  });
  await pipeline(bucket().openDownloadStream(file._id), res);
  return true;
}

export async function deletePrivateFile(storedName) {
  const file = await findPrivateFile(storedName);
  if (file) await bucket().delete(file._id);
}
