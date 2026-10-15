import path from "node:path";

const privateUploadRoot = path.resolve(process.env.PRIVATE_UPLOAD_DIR || "./private_uploads");

export const PUBLISHING_UPLOAD_ROOT = path.join(privateUploadRoot, "publishing");
export const LEGACY_PUBLISHING_UPLOAD_ROOT = path.resolve(process.cwd(), "public_uploads", "publishing");
