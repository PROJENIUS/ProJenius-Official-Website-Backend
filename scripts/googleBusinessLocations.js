import "dotenv/config";

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ACCOUNTS_URL = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
const LOCATIONS_API_ROOT = "https://mybusinessbusinessinformation.googleapis.com/v1";
const REQUIRED_ENV = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
];

export class GoogleBusinessLookupError extends Error {
  constructor(message, { status, reason } = {}) {
    super(message);
    this.name = "GoogleBusinessLookupError";
    this.status = status;
    this.reason = reason;
  }
}

function safeGoogleError(status, body) {
  const message = typeof body?.error?.message === "string" ? body.error.message : "";
  const normalized = message.toLowerCase();
  const errorCode = typeof body?.error === "string" ? body.error : "";
  if ((status === 400 || status === 401) && errorCode === "invalid_grant") {
    return new GoogleBusinessLookupError("The Google refresh token is invalid, expired, revoked, or was issued to a different OAuth client. Generate a new refresh token using this client ID.", { status, reason: "invalid_refresh_token" });
  }
  if ((status === 400 || status === 401) && errorCode === "invalid_client") {
    return new GoogleBusinessLookupError("Google rejected the OAuth client credentials. Verify that GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET belong to the same Web OAuth client used to generate the refresh token.", { status, reason: "invalid_oauth_client" });
  }
  if (status === 401 && (normalized.includes("invalid_grant") || normalized.includes("expired"))) {
    return new GoogleBusinessLookupError("The Google refresh token is invalid, expired, or revoked. Generate a new refresh token and try again.", { status, reason: "invalid_refresh_token" });
  }
  if (status === 401) {
    return new GoogleBusinessLookupError("Google rejected the OAuth credentials. Verify the OAuth client ID, client secret, and that the refresh token was generated for this same client.", { status, reason: "oauth_authorization_failed" });
  }
  if (status === 403) {
    return new GoogleBusinessLookupError("Google denied access. Confirm Business Profile API access is approved and enabled, and that this Google account has permission to manage the ProJenius profile.", { status, reason: "access_denied" });
  }
  if (status === 404) {
    return new GoogleBusinessLookupError("A required Business Profile API endpoint was not found. Check that the Account Management and Business Information APIs are enabled for this Cloud project.", { status, reason: "api_not_found" });
  }
  if (status === 400 && normalized.includes("invalid_grant")) {
    return new GoogleBusinessLookupError("The Google refresh token is invalid, expired, or revoked. Generate a new refresh token and try again.", { status, reason: "invalid_refresh_token" });
  }
  return new GoogleBusinessLookupError(`Google API request failed (HTTP ${status}). Check API enablement, project approval, and OAuth permissions.`, { status, reason: "google_api_error" });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw safeGoogleError(response.status, body);
  if (!body || typeof body !== "object") {
    throw new GoogleBusinessLookupError("Google returned an invalid response. Please retry.", { reason: "invalid_response" });
  }
  return body;
}

export function readGoogleCredentials(env = process.env) {
  const missing = REQUIRED_ENV.filter((key) => !env[key]?.trim());
  if (missing.length) {
    throw new GoogleBusinessLookupError(`Missing required environment variable(s): ${missing.join(", ")}. Set them in the backend .env file and retry.`, { reason: "missing_environment" });
  }
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID.trim(),
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET.trim(),
    refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN.trim(),
  };
}

export async function retrieveGoogleAccessToken(credentials) {
  const body = await requestJson(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new GoogleBusinessLookupError("Google did not return an access token. Check the OAuth credentials and refresh token.", { reason: "invalid_token_response" });
  }
  return body.access_token;
}

async function listAllPages(url, accessToken, pageSize) {
  const results = [];
  let pageToken;
  do {
    const pageUrl = new URL(url);
    pageUrl.searchParams.set("pageSize", String(pageSize));
    if (pageToken) pageUrl.searchParams.set("pageToken", pageToken);
    const body = await requestJson(pageUrl.href, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (Array.isArray(body.accounts)) results.push(...body.accounts);
    if (Array.isArray(body.locations)) results.push(...body.locations);
    pageToken = body.nextPageToken || "";
  } while (pageToken);
  return results;
}

export async function listBusinessAccounts(accessToken) {
  return listAllPages(ACCOUNTS_URL, accessToken, 20);
}

export async function listBusinessLocations(accountName, accessToken) {
  if (!/^accounts\/[^/]+$/.test(accountName || "")) {
    throw new GoogleBusinessLookupError("Google returned an account with an invalid resource name.", { reason: "invalid_account_name" });
  }
  const url = `${LOCATIONS_API_ROOT}/${accountName}/locations?readMask=name,title,storefrontAddress`;
  return listAllPages(url, accessToken, 100);
}

export async function discoverBusinessLocations(accessToken) {
  const accounts = await listBusinessAccounts(accessToken);
  if (!accounts.length) {
    throw new GoogleBusinessLookupError("No accessible Business Profile accounts were found. Authorize with a Google account that owns or manages the verified ProJenius profile.", { reason: "no_accounts" });
  }
  const results = [];
  for (const account of accounts) {
    if (!account.name) continue;
    const locations = await listBusinessLocations(account.name, accessToken);
    for (const location of locations) {
      const locationId = location.name?.split("/").at(-1);
      if (locationId) {
        // Business Information v1 returns locations/{locationId}; the existing
        // review endpoint uses the legacy account-qualified location resource.
        results.push({ account, location, reviewLocationName: `${account.name}/locations/${locationId}` });
      }
    }
  }
  if (!results.length) {
    throw new GoogleBusinessLookupError("No locations were returned for the accessible accounts. Confirm the account has a verified Business Profile location and that you have permission to manage it.", { reason: "no_locations" });
  }
  return results;
}

export function formatLocationChoices(results) {
  return results.map(({ account, location }, index) => {
    const accountLabel = account.accountName || account.name || "(account name unavailable)";
    const locationLabel = location.title || "(location title unavailable)";
    const address = location.storefrontAddress?.addressLines?.filter(Boolean).join(", ") || "";
    return `${index + 1}. ${locationLabel}${address ? ` — ${address}` : ""}\n   Account: ${accountLabel} [${account.name}]\n   Business Information API location: ${location.name}\n   Reviews API resource: ${results[index].reviewLocationName}`;
  }).join("\n");
}

export function getSelectionIndex(args, results) {
  const selectPosition = args.indexOf("--select");
  if (selectPosition === -1) return null;
  const raw = args[selectPosition + 1];
  if (!raw || !/^\d+$/.test(raw)) {
    throw new GoogleBusinessLookupError("Use --select followed by the numbered location shown in the list.", { reason: "invalid_selection" });
  }
  const index = Number(raw) - 1;
  if (index < 0 || index >= results.length) {
    throw new GoogleBusinessLookupError(`Selection must be between 1 and ${results.length}.`, { reason: "invalid_selection" });
  }
  return index;
}

export async function chooseLocation(results, args = process.argv.slice(2), io = { stdin, stdout }) {
  const index = getSelectionIndex(args, results);
  if (index !== null) return results[index];
  if (results.length === 1) return results[0];
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    throw new GoogleBusinessLookupError("Multiple locations were found. Rerun with --select <number> to choose one from the list.", { reason: "selection_required" });
  }
  const prompt = readline.createInterface({ input: io.stdin, output: io.stdout });
  try {
    const answer = await prompt.question(`Select the ProJenius location (1-${results.length}): `);
    const indexFromPrompt = getSelectionIndex(["--select", answer.trim()], results);
    return results[indexFromPrompt];
  } finally {
    prompt.close();
  }
}

export async function main(args = process.argv.slice(2), io = { stdin, stdout }) {
  try {
    const credentials = readGoogleCredentials();
    const accessToken = await retrieveGoogleAccessToken(credentials);
    const results = await discoverBusinessLocations(accessToken);
    io.stdout.write("Accessible Google Business Profile locations:\n\n");
    io.stdout.write(`${formatLocationChoices(results)}\n\n`);
    const selected = await chooseLocation(results, args, io);
    io.stdout.write("Copy this into the backend .env file:\n");
    io.stdout.write(`GOOGLE_BUSINESS_LOCATION_NAME=${selected.reviewLocationName}\n`);
    return 0;
  } catch (error) {
    io.stdout.write(`Google Business Profile lookup failed: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
