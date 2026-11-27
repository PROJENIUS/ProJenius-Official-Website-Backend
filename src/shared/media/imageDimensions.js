/* =========================================================
   IMAGE DIMENSIONS
   Reads the pixel width and height straight from PNG, JPEG
   and WebP file headers, so upload rules can check the real
   image instead of trusting what the browser reports. JPEG
   EXIF orientation is honoured, because browsers rotate those
   photos before showing them.
========================================================= */

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function exifOrientation(buffer, start, length) {
  // APP1 payload: "Exif\0\0" then a TIFF header.
  if (length < 14 || buffer.toString("ascii", start, start + 4) !== "Exif") return 1;
  const tiff = start + 6;
  const order = buffer.toString("ascii", tiff, tiff + 2);
  if (order !== "II" && order !== "MM") return 1;
  const little = order === "II";
  const u16 = (offset) => (little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset));
  const u32 = (offset) => (little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
  const end = start + length;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const entries = u16(ifd);
  for (let index = 0; index < entries; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) return 1;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return 1;
}

function jpegDimensions(buffer) {
  let offset = 2;
  let orientation = 1;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (marker === 0xe1 && orientation === 1) {
      try { orientation = exifOrientation(buffer, offset + 4, length - 2); } catch { orientation = 1; }
    }
    if (JPEG_SOF.has(marker)) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(buffer) {
  if (buffer.length < 30) return null;
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8 ") return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
  return null;
}

/** Returns { width, height } or null when the header cannot be read. */
export function imageDimensions(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) return null;
  try {
    const size = mimeType === "image/png" ? pngDimensions(buffer)
      : mimeType === "image/jpeg" ? jpegDimensions(buffer)
        : mimeType === "image/webp" ? webpDimensions(buffer)
          : null;
    return size && size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
}
