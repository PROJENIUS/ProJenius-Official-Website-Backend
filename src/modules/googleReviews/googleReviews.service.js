import {
  GOOGLE_REVIEWS_CACHE_TTL_MS,
  GOOGLE_REVIEWS_MAX_PAGES,
  GOOGLE_REVIEWS_PAGE_SIZE_DEFAULT,
} from "./googleReviews.constants.js";
import { fetchGoogleReviewPage } from "./googleReviews.provider.js";

const cache = new Map();
const inFlight = new Map();
const STAR_RATINGS = Object.freeze({ ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 });

function securePhotoUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function normalizeGoogleReview(review) {
  const reviewer = review?.reviewer || {};
  const isAnonymous = reviewer.isAnonymous === true;
  const rating = typeof review?.starRating === "number"
    ? review.starRating
    : STAR_RATINGS[review?.starRating] || 0;
  return {
    id: String(review?.reviewId || review?.name || ""),
    name: isAnonymous ? "Google user" : String(reviewer.displayName || "Google user"),
    profilePhotoUrl: isAnonymous ? null : securePhotoUrl(reviewer.profilePhotoUrl),
    rating,
    text: typeof review?.comment === "string" ? review.comment : "",
    date: typeof review?.createTime === "string" ? review.createTime : null,
    reviewUrl: securePhotoUrl(review?.reviewUrl),
  };
}

function normalizePageMetadata(body, profileUrl) {
  const rating = Number(body.averageRating);
  const totalReviews = Number(body.totalReviewCount);
  return {
    rating: Number.isFinite(rating) && rating > 0 ? rating : null,
    totalReviews: Number.isSafeInteger(totalReviews) && totalReviews >= 0 ? totalReviews : null,
    url: profileUrl,
  };
}

async function fetchAllReviews(pageSize, firstPage) {
  const reviews = [];
  const ids = new Set();
  const seenTokens = new Set();
  let pageToken;
  let metadata = { rating: null, totalReviews: null, url: firstPage.profileUrl };
  let currentPage = firstPage;

  for (let pageIndex = 0; pageIndex < GOOGLE_REVIEWS_MAX_PAGES; pageIndex += 1) {
    const result = currentPage || await fetchGoogleReviewPage({ pageSize, pageToken });
    currentPage = null;
    if (pageIndex === 0) metadata = normalizePageMetadata(result.body, result.profileUrl);
    for (const sourceReview of result.body.reviews) {
      const review = normalizeGoogleReview(sourceReview);
      if (review.id && review.rating >= 1 && review.rating <= 5 && !ids.has(review.id)) {
        ids.add(review.id);
        reviews.push(review);
      }
    }

    const nextPageToken = result.body.nextPageToken;
    if (!nextPageToken) {
      return {
        ...metadata,
        reviews,
        complete: true,
        lastSyncedAt: new Date().toISOString(),
      };
    }
    if (typeof nextPageToken !== "string" || seenTokens.has(nextPageToken)) {
      const error = new Error("GOOGLE_REVIEWS_INVALID_PAGINATION");
      error.code = "GOOGLE_REVIEWS_INVALID_PAGINATION";
      error.status = 502;
      throw error;
    }
    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  const error = new Error("GOOGLE_REVIEWS_PAGE_LIMIT_REACHED");
  error.code = "GOOGLE_REVIEWS_PAGE_LIMIT_REACHED";
  error.status = 503;
  throw error;
}

export async function getGoogleReviews({ pageSize = GOOGLE_REVIEWS_PAGE_SIZE_DEFAULT, pageToken } = {}) {
  if (pageToken) {
    const result = await fetchGoogleReviewPage({ pageSize, pageToken });
    return {
      ...normalizePageMetadata(result.body, result.profileUrl),
      reviews: result.body.reviews.map(normalizeGoogleReview)
        .filter((review) => review.id && review.rating >= 1 && review.rating <= 5),
      complete: !result.body.nextPageToken,
      nextPageToken: result.body.nextPageToken || null,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  const cacheKey = String(pageSize);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const request = (async () => {
    const firstPage = await fetchGoogleReviewPage({ pageSize });
    const result = await fetchAllReviews(pageSize, firstPage);
    cache.set(cacheKey, { value: result, expiresAt: Date.now() + GOOGLE_REVIEWS_CACHE_TTL_MS });
    while (cache.size > 5) cache.delete(cache.keys().next().value);
    return result;
  })().finally(() => inFlight.delete(cacheKey));

  inFlight.set(cacheKey, request);
  return request;
}

export function resetGoogleReviewsServiceForTests() {
  cache.clear();
  inFlight.clear();
}
