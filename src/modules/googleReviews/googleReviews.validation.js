import {
  GOOGLE_REVIEWS_PAGE_SIZE_DEFAULT,
  GOOGLE_REVIEWS_PAGE_SIZE_MAX,
} from "./googleReviews.constants.js";

export function parseReviewPagination(query = {}) {
  const rawSize = query.pageSize;
  let pageSize = GOOGLE_REVIEWS_PAGE_SIZE_DEFAULT;
  if (rawSize !== undefined) {
    if (Array.isArray(rawSize) || !/^\d+$/.test(String(rawSize))) {
      return { error: "pageSize must be an integer from 1 to 50." };
    }
    pageSize = Number(rawSize);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > GOOGLE_REVIEWS_PAGE_SIZE_MAX) {
      return { error: "pageSize must be an integer from 1 to 50." };
    }
  }

  const pageToken = query.pageToken;
  if (pageToken !== undefined && (
    typeof pageToken !== "string" ||
    pageToken.length < 1 ||
    pageToken.length > 2048 ||
    /[\u0000-\u001f\u007f]/.test(pageToken)
  )) {
    return { error: "pageToken is invalid." };
  }

  return { value: { pageSize, pageToken: pageToken || undefined } };
}
