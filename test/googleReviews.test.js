import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { after, before, test } from "node:test";
import { createGoogleReviewsRouter } from "../src/modules/googleReviews/googleReviews.routes.js";
import { resetGoogleReviewsProviderForTests, sanitizeDiagnosticText } from "../src/modules/googleReviews/googleReviews.provider.js";
import { getGoogleReviews, resetGoogleReviewsServiceForTests } from "../src/modules/googleReviews/googleReviews.service.js";
import { parseReviewPagination } from "../src/modules/googleReviews/googleReviews.validation.js";
import { registerApiRoutes } from "../src/routes/index.js";

const ENV_KEYS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
  "GOOGLE_BUSINESS_LOCATION_NAME",
  "GOOGLE_REVIEWS_PROFILE_URL",
];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const nativeFetch = globalThis.fetch;

function configure() {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret";
  process.env.GOOGLE_OAUTH_REFRESH_TOKEN = "test-refresh-token";
  process.env.GOOGLE_BUSINESS_LOCATION_NAME = "accounts/123/locations/456";
  process.env.GOOGLE_REVIEWS_PROFILE_URL = "https://example.com/reviews";
}

function reset() {
  resetGoogleReviewsServiceForTests();
  resetGoogleReviewsProviderForTests();
  globalThis.fetch = nativeFetch;
}

async function startServer(routerOptions) {
  const app = express();
  app.use("/api/reviews", createGoogleReviewsRouter(routerOptions));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return { server, url: "http://127.0.0.1:" + address.port + "/api/reviews" };
}

async function startRegisteredServer() {
  const app = express();
  registerApiRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return { server, url: "http://127.0.0.1:" + address.port + "/api/reviews" };
}

function mockGoogle({ reviewPages = [], reviewStatus = 200 } = {}) {
  const requestedTokens = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      assert.match(String(options.body), /grant_type=refresh_token/);
      return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }), { status: 200 });
    }
    if (url.startsWith("https://mybusiness.googleapis.com/v4/")) {
      const parsed = new URL(url);
      assert.equal(options.headers.Authorization, "Bearer test-access-token");
      const pageToken = parsed.searchParams.get("pageToken") || "";
      requestedTokens.push(pageToken);
      if (reviewStatus !== 200) return new Response("provider details must remain private", { status: reviewStatus });
      const pageIndex = pageToken ? Number(pageToken.replace("next-", "")) : 0;
      const body = reviewPages[pageIndex] || { reviews: [], averageRating: 4.8, totalReviewCount: 0 };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    throw new Error("Unexpected outbound request");
  };
  return requestedTokens;
}

before(() => configure());
after(() => {
  reset();
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test("validates page size and opaque Google page tokens", () => {
  assert.deepEqual(parseReviewPagination({ pageSize: "25" }), { value: { pageSize: 25, pageToken: undefined } });
  assert.equal(parseReviewPagination({ pageSize: "51" }).error, "pageSize must be an integer from 1 to 50.");
  assert.equal(parseReviewPagination({ pageSize: "1.5" }).error, "pageSize must be an integer from 1 to 50.");
  assert.equal(parseReviewPagination({ pageToken: "bad\ntoken" }).error, "pageToken is invalid.");
});

test("fetches every provider page, normalizes real fields, and reuses the bounded cache", async () => {
  reset();
  const tokens = mockGoogle({
    reviewPages: [
      {
        averageRating: 4.8,
        totalReviewCount: 57,
        nextPageToken: "next-1",
        reviews: [{
          reviewId: "review-1",
          reviewer: { displayName: "A Reviewer", profilePhotoUrl: "https://lh3.googleusercontent.com/photo", isAnonymous: false },
          starRating: "FIVE",
          comment: "Excellent support.",
          createTime: "2026-10-10T00:00:00Z",
          reviewUrl: "https://reviews.google.com/review-1",
        }, {
          reviewId: "review-no-photo",
          reviewer: { displayName: "No photo reviewer", isAnonymous: false },
          starRating: "THREE",
          comment: "A written review without a profile picture.",
        }],
      },
      {
        averageRating: 4.8,
        totalReviewCount: 57,
        reviews: [{
          reviewId: "review-2",
          reviewer: { displayName: "Private reviewer", profilePhotoUrl: "https://example.com/private", isAnonymous: true },
          starRating: "FOUR",
          comment: "",
        }],
      },
    ],
  });
  const result = await getGoogleReviews();
  assert.equal(result.rating, 4.8);
  assert.equal(result.totalReviews, 57);
  assert.equal(result.complete, true);
  assert.equal(result.reviews.length, 3);
  assert.deepEqual(tokens, ["", "next-1"]);
  assert.equal(result.reviews[0].profilePhotoUrl, "https://lh3.googleusercontent.com/photo");
  assert.equal(result.reviews[0].date, "2026-10-10T00:00:00Z");
  assert.equal(result.reviews[0].reviewUrl, "https://reviews.google.com/review-1");
  assert.equal(result.reviews[1].name, "No photo reviewer");
  assert.equal(result.reviews[1].profilePhotoUrl, null);
  assert.equal(result.reviews[2].name, "Google user");
  assert.equal(result.reviews[2].profilePhotoUrl, null);
  assert.equal(result.reviews[2].text, "");
  await getGoogleReviews();
  assert.equal(tokens.length, 2);
});

test("endpoint returns a safe missing-configuration response", async () => {
  reset();
  delete process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  const { server, url } = await startRegisteredServer();
  try {
    const response = await nativeFetch(url);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "Google Reviews integration is not configured.",
      code: "GOOGLE_REVIEWS_NOT_CONFIGURED",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    configure();
  }
});

test("honors an explicit Google page token and returns the provider's next token", async () => {
  reset();
  const tokens = mockGoogle({
    reviewPages: [
      { reviews: [], nextPageToken: "next-1", averageRating: 4.8, totalReviewCount: 57 },
      { reviews: [{ reviewId: "paged-review", reviewer: {}, starRating: "FIVE", comment: "Paged" }], nextPageToken: "next-2", averageRating: 4.8, totalReviewCount: 57 },
    ],
  });
  const result = await getGoogleReviews({ pageSize: 10, pageToken: "next-1" });
  assert.deepEqual(tokens, ["next-1"]);
  assert.equal(result.reviews[0].id, "paged-review");
  assert.equal(result.complete, false);
  assert.equal(result.nextPageToken, "next-2");
});

test("route rejects invalid page size before making Google requests", async () => {
  reset();
  let contactedGoogle = false;
  globalThis.fetch = async () => { contactedGoogle = true; throw new Error("should not be called"); };
  const { server, url } = await startServer();
  try {
    const response = await nativeFetch(url + "?pageSize=999");
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_GOOGLE_REVIEWS_QUERY");
    assert.equal(contactedGoogle, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("sanitizes Google rate-limit errors and applies public endpoint rate limits", async () => {
  reset();
  mockGoogle({ reviewStatus: 429 });
  const { server, url } = await startServer({ limit: 2 });
  try {
    const response = await nativeFetch(url);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, "GOOGLE_REVIEWS_UNAVAILABLE");
    assert.equal(JSON.stringify(body).includes("provider details"), false);

    const limited = await startServer({ limit: 1 });
    try {
      const first = await nativeFetch(limited.url);
      const second = await nativeFetch(limited.url);
      assert.notEqual(first.status, 429);
      assert.equal(second.status, 429);
    } finally {
      await new Promise((resolve) => limited.server.close(resolve));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("returns empty Google results without fabricating review content", async () => {
  reset();
  mockGoogle({ reviewPages: [{ averageRating: 0, totalReviewCount: 0, reviews: [] }] });
  const result = await getGoogleReviews();
  assert.deepEqual(result.reviews, []);
  assert.equal(result.totalReviews, 0);
  assert.equal(result.complete, true);
});

const SECRET_VALUES = ["test-client", "test-secret", "test-refresh-token", "test-access-token", "ya29.leakedAccessToken", "1//leakedRefreshToken"];
const DIAGNOSTIC_PREFIX = "Google Reviews provider diagnostic ";

function captureWarnings() {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => { lines.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ")); };
  return { lines, restore: () => { console.warn = original; } };
}

function diagnosticsFrom(lines) {
  return lines
    .filter((line) => line.startsWith(DIAGNOSTIC_PREFIX))
    .map((line) => JSON.parse(line.slice(DIAGNOSTIC_PREFIX.length)));
}

function assertNoSecrets(text) {
  for (const secret of SECRET_VALUES) assert.equal(text.includes(secret), false, "leaked " + secret);
  assert.equal(/Bearer\s/i.test(text), false);
  assert.equal(text.includes("AIzaSecret"), false);
}

async function captureFailure(run) {
  const capture = captureWarnings();
  let thrown;
  try {
    await run().catch((error) => { thrown = error; });
  } finally {
    capture.restore();
  }
  return { thrown, lines: capture.lines, diagnostics: diagnosticsFrom(capture.lines) };
}

function mockGoogleFailure({ tokenStatus = 200, tokenBody, reviewResponses = [] }) {
  const calls = { token: 0, reviews: 0 };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      calls.token += 1;
      const body = tokenBody ?? { access_token: "test-access-token", expires_in: 3600 };
      return new Response(JSON.stringify(body), { status: tokenStatus });
    }
    if (url.startsWith("https://mybusiness.googleapis.com/v4/")) {
      const next = reviewResponses[Math.min(calls.reviews, reviewResponses.length - 1)];
      calls.reviews += 1;
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify(next.body), { status: next.status });
    }
    throw new Error("Unexpected outbound request");
  };
  return calls;
}

const leakyApiError = (code, status, reason) => ({
  error: {
    code,
    status,
    message: "Request denied. Bearer ya29.leakedAccessToken see https://console.developers.google.com/apis/api/mybusiness.googleapis.com/overview?project=1&key=AIzaSecret refresh 1//leakedRefreshToken test-secret",
    details: [{
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason,
      domain: "googleapis.com",
      metadata: { service: "mybusiness.googleapis.com", consumer: "projects/1" },
    }],
  },
});

test("diagnoses OAuth refresh-token exchange failures without leaking credentials", async () => {
  reset();
  const calls = mockGoogleFailure({
    tokenStatus: 400,
    tokenBody: { error: "invalid_grant", error_description: "Token has been expired or revoked: test-refresh-token" },
  });
  const { thrown, lines, diagnostics } = await captureFailure(() => getGoogleReviews());
  assert.equal(calls.token, 1);
  assert.equal(calls.reviews, 0);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(thrown.diagnostic, diagnostics[0]);
  assert.equal(diagnostics[0].stage, "oauth_token_refresh");
  assert.equal(diagnostics[0].category, "oauth_refresh_failed");
  assert.equal(diagnostics[0].httpStatus, 400);
  assert.equal(diagnostics[0].googleReason, "invalid_grant");
  assert.equal(diagnostics[0].googleMessage, "Token has been expired or revoked: [REDACTED]");
  assertNoSecrets(lines.join("\n"));
});

test("classifies a token response without an access token as an OAuth refresh failure", async () => {
  reset();
  mockGoogleFailure({ tokenBody: { token_type: "Bearer" } });
  const { thrown } = await captureFailure(() => getGoogleReviews());
  assert.equal(thrown.code, "GOOGLE_REVIEWS_AUTHORIZATION_FAILED");
  assert.equal(thrown.diagnostic.category, "oauth_refresh_failed");
  assert.equal(thrown.diagnostic.failure, "token_response_missing_fields");
});

test("diagnoses reviews endpoint 401, refreshing the token and retrying exactly once", async () => {
  reset();
  const calls = mockGoogleFailure({
    reviewResponses: [{ status: 401, body: leakyApiError(401, "UNAUTHENTICATED", "ACCESS_TOKEN_EXPIRED") }],
  });
  const { thrown, lines, diagnostics } = await captureFailure(() => getGoogleReviews());
  assert.equal(calls.token, 2);
  assert.equal(calls.reviews, 2);
  assert.equal(diagnostics.length, 2);
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.stage, "reviews_list");
    assert.equal(diagnostic.category, "reviews_unauthorized");
    assert.equal(diagnostic.httpStatus, 401);
    assert.equal(diagnostic.googleStatus, "UNAUTHENTICATED");
    assert.equal(diagnostic.googleReason, "ACCESS_TOKEN_EXPIRED");
  }
  assert.equal(thrown.diagnostic.category, "reviews_unauthorized");
  assertNoSecrets(lines.join("\n"));
});

test("diagnoses reviews endpoint 403 without retrying and keeps details out of the public response", async () => {
  reset();
  const calls = mockGoogleFailure({
    reviewResponses: [{ status: 403, body: leakyApiError(403, "PERMISSION_DENIED", "SERVICE_DISABLED") }],
  });
  const { server, url } = await startServer();
  let response;
  let text;
  const capture = captureWarnings();
  try {
    response = await nativeFetch(url);
    text = await response.text();
  } finally {
    capture.restore();
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(calls.token, 1);
  assert.equal(calls.reviews, 1);
  const [diagnostic] = diagnosticsFrom(capture.lines);
  assert.equal(diagnostic.stage, "reviews_list");
  assert.equal(diagnostic.category, "reviews_forbidden");
  assert.equal(diagnostic.httpStatus, 403);
  assert.equal(diagnostic.googleStatus, "PERMISSION_DENIED");
  assert.equal(diagnostic.googleReason, "SERVICE_DISABLED");
  assert.equal(diagnostic.googleService, "mybusiness.googleapis.com");
  assert.match(diagnostic.googleMessage, /https:\/\/console\.developers\.google\.com\/apis\/api\/mybusiness\.googleapis\.com\/overview /);
  assertNoSecrets(capture.lines.join("\n"));

  assert.equal(response.status, 502);
  assert.deepEqual(JSON.parse(text), {
    error: "Google Reviews are temporarily unavailable.",
    code: "GOOGLE_REVIEWS_UNAVAILABLE",
  });
  assertNoSecrets(text);
  for (const fragment of ["PERMISSION_DENIED", "SERVICE_DISABLED", "Request denied", "reviews_forbidden"]) {
    assert.equal(text.includes(fragment), false);
  }
});

test("classifies other provider failures generically", async () => {
  reset();
  mockGoogleFailure({ reviewResponses: [{ status: 500, body: leakyApiError(500, "INTERNAL", "BACKEND_ERROR") }] });
  let result = await captureFailure(() => getGoogleReviews());
  assert.equal(result.thrown.code, "GOOGLE_REVIEWS_PROVIDER_UNAVAILABLE");
  assert.equal(result.thrown.diagnostic.category, "provider_failure");
  assert.equal(result.thrown.diagnostic.httpStatus, 500);
  assertNoSecrets(result.lines.join("\n"));

  reset();
  mockGoogleFailure({ reviewResponses: [new TypeError("fetch failed for Bearer ya29.leakedAccessToken")] });
  result = await captureFailure(() => getGoogleReviews());
  assert.deepEqual(result.thrown.diagnostic, { stage: "reviews_list", category: "provider_failure", failure: "network_error" });
  assertNoSecrets(result.lines.join("\n"));
});

test("sanitizes diagnostic text", () => {
  assert.equal(sanitizeDiagnosticText(undefined), undefined);
  assert.equal(
    sanitizeDiagnosticText("bad my-client-secret Bearer abc.def access_token=xyz https://x.test/a?refresh_token=1//r\n", ["my-client-secret"]),
    "bad [REDACTED] [REDACTED] [REDACTED] https://x.test/a",
  );
  assert.equal(sanitizeDiagnosticText("x".repeat(1000)).length, 300);
});
