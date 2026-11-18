import {
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_REVIEWS_API_ROOT,
  GOOGLE_REVIEWS_ENV,
  GOOGLE_REVIEWS_PROFILE_URL_DEFAULT,
  GOOGLE_REVIEWS_REQUEST_TIMEOUT_MS,
} from "./googleReviews.constants.js";

export class GoogleReviewsProviderError extends Error {
  constructor(code, status = 503, diagnostic = null) {
    super(code);
    this.name = "GoogleReviewsProviderError";
    this.code = code;
    this.status = status;
    this.diagnostic = diagnostic;
  }
}

export const GOOGLE_REVIEWS_STAGE = Object.freeze({
  oauthToken: "oauth_token_refresh",
  reviews: "reviews_list",
});

let accessToken = "";
let accessTokenExpiresAt = 0;

const SECRET_PATTERNS = [
  /ya29\.[\w.~+/-]+/g,
  /1\/\/[\w.~+/-]+/g,
  /\bBearer\s+\S+/gi,
  /\b(?:access_token|refresh_token|client_secret|client_id|code|key|token)=[^&\s"']+/gi,
];
const DIAGNOSTIC_TEXT_MAX = 300;

// Server-log-only text: redacts known credentials and token shapes, drops URL query strings.
export function sanitizeDiagnosticText(value, secrets = []) {
  if (typeof value !== "string" || !value) return undefined;
  let text = value;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) text = text.split(secret).join("[REDACTED]");
  }
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  text = text.replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/gi, "$1");
  text = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return text.slice(0, DIAGNOSTIC_TEXT_MAX) || undefined;
}

function safeIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : undefined;
}

function readGoogleErrorBody(body, secrets) {
  if (!body || typeof body !== "object") return {};
  // OAuth token endpoint: { error: "invalid_grant", error_description: "..." }
  if (typeof body.error === "string") {
    return {
      googleReason: safeIdentifier(body.error),
      googleMessage: sanitizeDiagnosticText(body.error_description, secrets),
    };
  }
  // Google APIs: { error: { code, status, message, details: [{ reason, domain, metadata }] } }
  if (body.error && typeof body.error === "object") {
    const details = Array.isArray(body.error.details) ? body.error.details : [];
    const errorInfo = details.find((detail) => typeof detail?.reason === "string") || {};
    return {
      googleStatus: safeIdentifier(body.error.status),
      googleReason: safeIdentifier(errorInfo.reason),
      googleDomain: safeIdentifier(errorInfo.domain),
      googleService: safeIdentifier(errorInfo.metadata?.service),
      googleMessage: sanitizeDiagnosticText(body.error.message, secrets),
    };
  }
  return {};
}

// Timeouts and network errors stay "provider_failure" at every stage: Google never answered.
export function classifyProviderFailure(stage, httpStatus, failure) {
  const answered = failure !== "timeout" && failure !== "network_error";
  if (stage === GOOGLE_REVIEWS_STAGE.oauthToken && answered) return "oauth_refresh_failed";
  if (stage === GOOGLE_REVIEWS_STAGE.reviews && httpStatus === 401) return "reviews_unauthorized";
  if (stage === GOOGLE_REVIEWS_STAGE.reviews && httpStatus === 403) return "reviews_forbidden";
  return "provider_failure";
}

function buildDiagnostic(stage, { httpStatus, failure, body, secrets = [] } = {}) {
  const diagnostic = {
    stage,
    category: classifyProviderFailure(stage, httpStatus, failure),
    httpStatus: httpStatus || undefined,
    failure,
    ...readGoogleErrorBody(body, secrets),
  };
  return Object.fromEntries(Object.entries(diagnostic).filter(([, value]) => value !== undefined));
}

function logProviderDiagnostic(diagnostic) {
  console.warn("Google Reviews provider diagnostic", diagnostic);
}

function failWithDiagnostic(code, status, stage, details) {
  const diagnostic = buildDiagnostic(stage, details);
  logProviderDiagnostic(diagnostic);
  return new GoogleReviewsProviderError(code, status, diagnostic);
}

function readConfig(env = process.env) {
  const clientId = env[GOOGLE_REVIEWS_ENV.clientId]?.trim();
  const clientSecret = env[GOOGLE_REVIEWS_ENV.clientSecret]?.trim();
  const refreshToken = env[GOOGLE_REVIEWS_ENV.refreshToken]?.trim();
  const locationName = env[GOOGLE_REVIEWS_ENV.locationName]?.trim();
  const missing = [];
  if (!clientId) missing.push(GOOGLE_REVIEWS_ENV.clientId);
  if (!clientSecret) missing.push(GOOGLE_REVIEWS_ENV.clientSecret);
  if (!refreshToken) missing.push(GOOGLE_REVIEWS_ENV.refreshToken);
  if (!locationName || !/^accounts\/\d+\/locations\/\d+$/.test(locationName)) {
    missing.push(GOOGLE_REVIEWS_ENV.locationName);
  }
  if (missing.length) throw new GoogleReviewsProviderError("GOOGLE_REVIEWS_NOT_CONFIGURED", 503);

  const profileUrl = env[GOOGLE_REVIEWS_ENV.profileUrl]?.trim();
  return {
    clientId,
    clientSecret,
    refreshToken,
    locationName,
    profileUrl: profileUrl && /^https:\/\//i.test(profileUrl)
      ? profileUrl
      : GOOGLE_REVIEWS_PROFILE_URL_DEFAULT,
  };
}

function configSecrets(config) {
  return [config.clientId, config.clientSecret, config.refreshToken, accessToken];
}

async function fetchJson(url, options, stage, secrets) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_REVIEWS_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const code = response.status === 429
        ? "GOOGLE_REVIEWS_PROVIDER_RATE_LIMITED"
        : response.status === 401 || response.status === 403
          ? "GOOGLE_REVIEWS_AUTHORIZATION_FAILED"
          : "GOOGLE_REVIEWS_PROVIDER_UNAVAILABLE";
      throw failWithDiagnostic(code, response.status === 429 ? 503 : 502, stage, {
        httpStatus: response.status,
        failure: "http_error",
        body,
        secrets,
      });
    }
    if (!body || typeof body !== "object") {
      throw failWithDiagnostic("GOOGLE_REVIEWS_INVALID_PROVIDER_RESPONSE", 502, stage, { failure: "invalid_json" });
    }
    return body;
  } catch (error) {
    if (error instanceof GoogleReviewsProviderError) throw error;
    const timedOut = error?.name === "AbortError";
    throw failWithDiagnostic(
      timedOut ? "GOOGLE_REVIEWS_PROVIDER_TIMEOUT" : "GOOGLE_REVIEWS_PROVIDER_UNAVAILABLE",
      503,
      stage,
      { failure: timedOut ? "timeout" : "network_error" },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function refreshAccessToken(config) {
  const form = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: "refresh_token",
  });
  const result = await fetchJson(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form,
  }, GOOGLE_REVIEWS_STAGE.oauthToken, configSecrets(config));
  if (typeof result.access_token !== "string" || !result.access_token || !Number.isFinite(Number(result.expires_in))) {
    throw failWithDiagnostic("GOOGLE_REVIEWS_AUTHORIZATION_FAILED", 503, GOOGLE_REVIEWS_STAGE.oauthToken, {
      failure: "token_response_missing_fields",
    });
  }
  accessToken = result.access_token;
  accessTokenExpiresAt = Date.now() + Math.max(0, Number(result.expires_in) - 60) * 1000;
  return accessToken;
}

async function getAccessToken(config, forceRefresh = false) {
  if (!forceRefresh && accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
  return refreshAccessToken(config);
}

async function requestReviewPage(config, pageSize, pageToken, retryUnauthorized = true) {
  const token = await getAccessToken(config);
  const url = new URL(GOOGLE_REVIEWS_API_ROOT + "/" + config.locationName + "/reviews");
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("orderBy", "updateTime desc");
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  let body;
  try {
    body = await fetchJson(url.href, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    }, GOOGLE_REVIEWS_STAGE.reviews, configSecrets(config));
  } catch (error) {
    // Only an expired/invalid access token (401) can be fixed by refreshing; 403 is a permission problem.
    if (retryUnauthorized && error.diagnostic?.category === "reviews_unauthorized") {
      accessToken = "";
      accessTokenExpiresAt = 0;
      await getAccessToken(config, true);
      return requestReviewPage(config, pageSize, pageToken, false);
    }
    throw error;
  }
  if (!Array.isArray(body.reviews)) {
    throw failWithDiagnostic("GOOGLE_REVIEWS_INVALID_PROVIDER_RESPONSE", 502, GOOGLE_REVIEWS_STAGE.reviews, {
      failure: "reviews_field_missing",
    });
  }
  return body;
}

export async function fetchGoogleReviewPage({ pageSize, pageToken } = {}) {
  const config = readConfig();
  return {
    body: await requestReviewPage(config, pageSize, pageToken),
    profileUrl: config.profileUrl,
  };
}

export function resetGoogleReviewsProviderForTests() {
  accessToken = "";
  accessTokenExpiresAt = 0;
}
