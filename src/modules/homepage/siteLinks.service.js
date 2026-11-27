/* =========================================================
   WEBSITE LINK LIST FOR THE ADMIN "OPENS" DROPDOWN
   The website publishes /site-links.json, made from its own
   list of pages and sections (website src/siteLinks.js). When
   a developer adds a page there, it appears in the admin panel
   after the website is deployed, with no backend or admin
   change. Only the configured public site is ever fetched
   (never an address from a request), every link is checked
   against the same "page on this website" rule used on save,
   and the built-in list is used whenever the file is missing.
========================================================= */

import { getPublicSiteOrigin } from "../../config/siteOrigins.js";
import { HERO_LINK_SUGGESTIONS, HERO_RULES } from "./homeHero.rules.js";

const CACHE_MS = 10 * 60 * 1000;
const FAILED_RETRY_MS = 60 * 1000;
const TIMEOUT_MS = 3000;
const MAX_BYTES = 64 * 1024;
const MAX_LINKS = 200;
const LINK = new RegExp(HERO_RULES.linkPattern, "i");

let cache = null;

function cleanLinks(body) {
  if (!body || !Array.isArray(body.links)) return null;
  const seen = new Set();
  const links = [];
  for (const entry of body.links.slice(0, MAX_LINKS)) {
    const label = typeof entry?.label === "string" ? entry.label.replace(/\s+/g, " ").trim().slice(0, 60) : "";
    const to = typeof entry?.to === "string" ? entry.to.trim() : "";
    if (!label || !to || to.length > HERO_RULES.linkMax || !LINK.test(to) || seen.has(to)) continue;
    seen.add(to);
    links.push({ label, to });
  }
  return links.length ? links : null;
}

async function fetchSiteLinks() {
  const url = new URL("/site-links.json", getPublicSiteOrigin());
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } });
  if (!response.ok) return null;
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_BYTES) return null;
  const text = await response.text();
  if (text.length > MAX_BYTES) return null;
  return cleanLinks(JSON.parse(text));
}

/** { links, source: "website" | "built-in" } — never throws. */
export async function getHeroLinks({ now = Date.now() } = {}) {
  if (process.env.NODE_ENV === "test" && !process.env.SITE_LINKS_FETCH) return { links: HERO_LINK_SUGGESTIONS, source: "built-in" };
  if (cache && cache.expires > now) return cache.value;
  let links = null;
  try { links = await fetchSiteLinks(); } catch { links = null; }
  const value = links ? { links, source: "website" } : { links: HERO_LINK_SUGGESTIONS, source: "built-in" };
  cache = { value, expires: now + (links ? CACHE_MS : FAILED_RETRY_MS) };
  return value;
}

export const siteLinksInternals = { cleanLinks, reset: () => { cache = null; } };
