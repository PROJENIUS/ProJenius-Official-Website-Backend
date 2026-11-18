import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverBusinessLocations,
  formatLocationChoices,
  getSelectionIndex,
  readGoogleCredentials,
  retrieveGoogleAccessToken,
} from "../scripts/googleBusinessLocations.js";

const nativeFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = nativeFetch;
});

test("requires all OAuth values without including any values in the error", () => {
  assert.throws(
    () => readGoogleCredentials({ GOOGLE_OAUTH_CLIENT_ID: "private-client-id" }),
    (error) => error.reason === "missing_environment"
      && error.message.includes("GOOGLE_OAUTH_CLIENT_SECRET")
      && !error.message.includes("private-client-id"),
  );
});

test("exchanges refresh credentials for an access token without logging them", async () => {
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, body: options.body.toString() };
    return Response.json({ access_token: "sensitive-access-token", expires_in: 3600 });
  };
  const token = await retrieveGoogleAccessToken({ clientId: "client", clientSecret: "secret", refreshToken: "refresh" });
  assert.equal(token, "sensitive-access-token");
  assert.equal(captured.url, "https://oauth2.googleapis.com/token");
  assert.match(captured.body, /grant_type=refresh_token/);
  assert.match(captured.body, /client_secret=secret/);
});

test("reports invalid refresh grants and rejected OAuth clients without echoing response credentials", async () => {
  globalThis.fetch = async () => Response.json({ error: "invalid_grant", error_description: "refresh token rejected" }, { status: 400 });
  await assert.rejects(
    retrieveGoogleAccessToken({ clientId: "client", clientSecret: "secret", refreshToken: "private-refresh-token" }),
    (error) => error.reason === "invalid_refresh_token" && !error.message.includes("private-refresh-token"),
  );
  globalThis.fetch = async () => Response.json({ error: "invalid_client" }, { status: 401 });
  await assert.rejects(
    retrieveGoogleAccessToken({ clientId: "client", clientSecret: "secret", refreshToken: "refresh" }),
    (error) => error.reason === "invalid_oauth_client" && error.message.includes("same Web OAuth client"),
  );
});

test("lists all accounts and all location pages using the expected Business Profile APIs", async () => {
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(new URL(url));
    if (String(url).includes("accountmanagement")) {
      return Response.json({ accounts: [{ name: "accounts/12", accountName: "ProJenius Account" }] });
    }
    const parsed = new URL(url);
    if (parsed.searchParams.get("pageToken") === "next") {
      return Response.json({ locations: [{ name: "locations/102", title: "ProJenius Annex" }] });
    }
    return Response.json({
      locations: [{ name: "locations/101", title: "ProJenius Innovation Technology" }],
      nextPageToken: "next",
    });
  };
  const found = await discoverBusinessLocations("private-access-token");
  assert.equal(found.length, 2);
  assert.equal(found[0].location.name, "locations/101");
  assert.equal(found[0].reviewLocationName, "accounts/12/locations/101");
  assert.equal(requested[0].origin + requested[0].pathname, "https://mybusinessaccountmanagement.googleapis.com/v1/accounts");
  assert.equal(requested[1].origin, "https://mybusinessbusinessinformation.googleapis.com");
  assert.equal(requested[0].searchParams.get("pageSize"), "20");
  assert.equal(requested[1].searchParams.get("readMask"), "name,title,storefrontAddress");
  assert.equal(requested[1].searchParams.get("pageSize"), "100");
  assert.equal(requested[2].searchParams.get("pageToken"), "next");
  assert.doesNotMatch(formatLocationChoices(found), /private-access-token/);
});

test("validates a numbered selection", () => {
  assert.equal(getSelectionIndex(["--select", "2"], [{}, {}]), 1);
  assert.throws(() => getSelectionIndex(["--select", "3"], [{}, {}]), { reason: "invalid_selection" });
});

