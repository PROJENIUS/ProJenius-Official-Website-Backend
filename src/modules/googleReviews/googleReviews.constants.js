export const GOOGLE_REVIEWS_API_ROOT = "https://mybusiness.googleapis.com/v4";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVIEWS_PAGE_SIZE_DEFAULT = 50;
export const GOOGLE_REVIEWS_PAGE_SIZE_MAX = 50;
export const GOOGLE_REVIEWS_MAX_PAGES = 100;
export const GOOGLE_REVIEWS_CACHE_TTL_MS = 5 * 60 * 1000;
export const GOOGLE_REVIEWS_REQUEST_TIMEOUT_MS = 10000;
export const GOOGLE_REVIEWS_PROFILE_URL_DEFAULT = "https://g.page/r/CZjzujTb9EXCEBM/review";

export const GOOGLE_REVIEWS_ENV = Object.freeze({
  clientId: "GOOGLE_OAUTH_CLIENT_ID",
  clientSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
  refreshToken: "GOOGLE_OAUTH_REFRESH_TOKEN",
  locationName: "GOOGLE_BUSINESS_LOCATION_NAME",
  profileUrl: "GOOGLE_REVIEWS_PROFILE_URL",
});
