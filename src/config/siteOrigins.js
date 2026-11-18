export const DEFAULT_PUBLIC_SITE_ORIGIN = "https://pro-jenius-official-website-fronten.vercel.app";
export const DEFAULT_ADMIN_SITE_ORIGIN = "https://pro-jenius-admin-website-frontend.vercel.app";
export const DEFAULT_PUBLIC_API_ORIGIN = "https://projenius-official-website-backend.onrender.com";

const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeOrigin(value, fallback) {
  const candidate = String(value || fallback).trim();
  try {
    const url = new URL(candidate);
    const localDevelopmentOrigin = process.env.NODE_ENV !== "production"
      && url.protocol === "http:"
      && localHosts.has(url.hostname.toLowerCase());
    if (url.username || url.password || url.search || url.hash) return fallback;
    if (url.protocol !== "https:" && !localDevelopmentOrigin) return fallback;
    if (process.env.NODE_ENV === "production" && localHosts.has(url.hostname.toLowerCase())) return fallback;
    return url.origin;
  } catch {
    return fallback;
  }
}

export function getPublicSiteOrigin() {
  return normalizeOrigin(process.env.PUBLIC_SITE_ORIGIN, DEFAULT_PUBLIC_SITE_ORIGIN);
}

export function getAdminSiteOrigin() {
  return normalizeOrigin(process.env.ADMIN_SITE_ORIGIN, DEFAULT_ADMIN_SITE_ORIGIN);
}

export function getPublicApiOrigin() {
  const fallback = process.env.NODE_ENV === "production" ? DEFAULT_PUBLIC_API_ORIGIN : "http://localhost:5000";
  return normalizeOrigin(process.env.PUBLIC_API_ORIGIN, fallback);
}

export function getAllowedOrigins() {
  return [...new Set([
    DEFAULT_ADMIN_SITE_ORIGIN,
    DEFAULT_PUBLIC_SITE_ORIGIN,
    getAdminSiteOrigin(),
    getPublicSiteOrigin(),
    ...(process.env.NODE_ENV === "production" ? [] : ["http://localhost:5173", "http://localhost:5174"]),
  ])];
}

export function isAllowedAdminOrigin(value) {
  if (typeof value !== "string") return false;
  try {
    const origin = new URL(value).origin;
    return origin === DEFAULT_ADMIN_SITE_ORIGIN
      || origin === getAdminSiteOrigin()
      || (process.env.NODE_ENV !== "production" && ["http://localhost:5174", "http://127.0.0.1:5174"].includes(origin));
  } catch {
    return false;
  }
}
