/* =========================================================
   UPLOADED IMAGE CHECKS
   One place that decides whether an uploaded file really is
   a PNG, JPEG or WebP image (by its bytes, not its name) and
   how large it is in pixels.
========================================================= */

import path from "node:path";
import { imageDimensions } from "./imageDimensions.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_TYPES = [
  { mime: "image/png", ext: "png", extensions: ["png"], check: (buffer) => buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  { mime: "image/jpeg", ext: "jpg", extensions: ["jpg", "jpeg"], check: (buffer) => buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 },
  { mime: "image/webp", ext: "webp", extensions: ["webp"], check: (buffer) => buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP" },
];

/**
 * Checks a multer memory-storage file. Returns { error } or
 * { mime, ext, width, height } for a genuine image.
 */
export function inspectUploadedImage(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.size < 1 || file.size > MAX_IMAGE_BYTES) {
    return { error: "Select an image up to 5 MB." };
  }
  const extension = path.extname(String(file.originalname || "")).slice(1).toLowerCase();
  const type = IMAGE_TYPES.find((entry) => entry.mime === file.mimetype && entry.extensions.includes(extension) && entry.check(file.buffer));
  if (!type) return { error: "Only valid PNG, JPEG or WebP images are supported." };
  const size = imageDimensions(file.buffer, type.mime);
  if (!size) return { error: "The image could not be read. Export it again as PNG, JPEG or WebP." };
  return { mime: type.mime, ext: type.ext, width: size.width, height: size.height };
}
