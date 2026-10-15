export function publicAssetUrl(path) {
  const relativePath = `/${String(path || "").replace(/^\/+/, "")}`;
  const configuredOrigin = process.env.PUBLIC_API_ORIGIN?.trim();
  if (!configuredOrigin) return relativePath;

  try {
    const url = new URL(configuredOrigin);
    if (url.username || url.password || url.search || url.hash) return relativePath;
    const localHost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
    if (localHost || url.protocol !== "https:") return relativePath;
    return `${url.origin}${relativePath}`;
  } catch {
    return relativePath;
  }
}
