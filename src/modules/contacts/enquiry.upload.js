
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

export const PRIVATE_UPLOAD_DIR = path.resolve(
  process.env.PRIVATE_UPLOAD_DIR || "./private_uploads"
);

fs.mkdirSync(PRIVATE_UPLOAD_DIR, { recursive: true });

const MAX_FILE_SIZE = 5 * 1024 * 1024;

const ALLOWED_FILES = {
  ".pdf": ["application/pdf"],
  ".doc": ["application/msword"],
  ".docx": [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  ".ppt": ["application/vnd.ms-powerpoint"],
  ".pptx": [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
};

const storage = multer.diskStorage({
  destination(_req, _file, callback) {
    callback(null, PRIVATE_UPLOAD_DIR);
  },

  filename(_req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${crypto.randomUUID()}${extension}`);
  },
});

function fileFilter(_req, file, callback) {
  const extension = path.extname(file.originalname).toLowerCase();
  const allowedMimeTypes = ALLOWED_FILES[extension];

  if (!allowedMimeTypes || !allowedMimeTypes.includes(file.mimetype)) {
    const error = new Error(
      "Please upload a PDF, DOC, DOCX, PPT, PPTX, PNG or JPG file."
    );
    error.status = 400;
    return callback(error);
  }

  callback(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
    fields: 2,
    fieldSize: 100 * 1024,
    parts: 3,
  },
});

export const uploadEnquiryAttachment = upload.single("attachment");
