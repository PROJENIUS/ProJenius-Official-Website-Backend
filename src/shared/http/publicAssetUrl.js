import { getPublicApiOrigin } from "../../config/siteOrigins.js";

export function publicAssetUrl(path) {
  const relativePath = `/${String(path || "").replace(/^\/+/, "")}`;
  try {
    const url = new URL(getPublicApiOrigin());
    const localHost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
    if (localHost) return relativePath;
    return `${url.origin}${relativePath}`;
  } catch {
    return relativePath;
  }
}
