# ProJenius Backend

One Express application serves the public website and the admin portal. It uses one Mongoose connection configured for the `ProJeniusBackend` database. Mongo-backed sessions use that same database and the `sessions` collection.

## Architecture

```text
src/
  app.js                       Express security/session setup and health check
  server.js                    Runtime validation, database startup and shutdown
  config/database.js           Single MongoDB connection and model/index startup
  middleware/                  Admin authentication and CSRF checks
  routes/index.js              Central registration of existing API route groups
  modules/
    admin/auth/                Admin login, sessions, invitations and recovery
    contacts/                  Seven-type contact endpoint, validation, uploads,
                                enquiry persistence and protected enquiry APIs
    careers/                   Job application model and persistence service
  shared/
    email/                     Contact notification transport, templates and exports
    pdf/                       Shared submission receipt generator and exports
scripts/
  createInitialAdmin.js        Guarded one-time superadmin bootstrap
test/                          Isolated MongoDB integration and unit tests
```

### Module responsibilities and current availability

- **Admin authentication** lives in `modules/admin/auth`: login/logout, CSRF token issuance, current-session checks, invitation-only admin onboarding, forgot/reset password, and their models and validation.
- **Contacts** lives in `modules/contacts`: the existing multipart submission endpoint, all seven enquiry choices, field validation, upload handling, reference assignment, enquiry storage, notification scheduling, and protected enquiry list/detail/status/file APIs.
- **Careers** owns the `JobApplication` model and career persistence service, exported through `modules/careers/index.js`. Career submissions are still dispatched through the existing Contact endpoint and contact service to preserve the website’s request contract. The internship enquiry remains an enquiry record; the career application is saved as a job application. The combined seven-choice payload validation remains in Contacts because it validates that existing shared endpoint.
- **Shared email and PDF** services live in `shared/email` and `shared/pdf`, with module entry points in each folder. The PDF layout and pagination behavior are unchanged by this folder reorganisation.
- **Courses, standalone registrations, blog publishing, and media APIs** are not implemented in this backend. No empty placeholder modules are included for them.
- **Dashboard aggregates** do not have a dedicated backend endpoint. The admin portal can obtain enquiry and career totals from the existing authenticated paginated list APIs; other dashboard totals are unavailable until corresponding domain features exist.

## Route map

`routes/index.js` registers the route groups. Their current public paths and methods are:

| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/health` | `GET` | Database availability health check |
| `/api/admin/auth/csrf` | `GET` | Issue an admin CSRF token |
| `/api/admin/auth/login` | `POST` | Admin login |
| `/api/admin/auth/logout` | `POST` | Authenticated admin logout |
| `/api/admin/auth/me` | `GET` | Current authenticated admin |
| `/api/admin/auth/invitations` | `POST` | Invite an additional admin |
| `/api/admin/auth/invitations/accept` | `POST` | Accept a one-time admin invitation |
| `/api/admin/auth/password/forgot` | `POST` | Request a password reset |
| `/api/admin/auth/password/reset` | `POST` | Consume a one-time reset token |
| `/api/contact/enquiries` | `POST` | Multipart contact submission (`payload` JSON field and optional `attachment`; a career application requires a resume) |
| `/api/admin/enquiries` | `GET` | Authenticated, paginated enquiry list/search |
| `/api/admin/enquiries/:id` | `GET` | Authenticated enquiry details |
| `/api/admin/enquiries/:id/status` | `PATCH` | Update enquiry status with CSRF protection |
| `/api/admin/enquiries/:id/receipt` | `GET` | Download an authorised enquiry receipt |
| `/api/admin/enquiries/:id/attachment` | `GET` | Download an authorised enquiry attachment |
| `/api/admin/job-applications` | `GET` | Authenticated, paginated application list/search |
| `/api/admin/job-applications/:id` | `GET` | Authenticated application details |
| `/api/admin/job-applications/:id/status` | `PATCH` | Update application status with CSRF protection |
| `/api/admin/job-applications/:id/receipt` | `GET` | Download an authorised application receipt |
| `/api/admin/job-applications/:id/resume` | `GET` | Download an authorised resume |

Admin management routes retain authentication middleware; state-changing admin routes retain CSRF protection. CORS remains origin-allowlisted, sessions remain HTTP-only, and upload/request limits remain in place.

## Database integrity

`config/database.js` sets the database name to `ProJeniusBackend`. `connectDatabase()` opens the single Mongoose connection and verifies the selected database. `connect-mongo` uses the same URI and database name for sessions. Models keep their existing collection names and declared indexes; startup creates missing collections/indexes without dropping existing ones.

Automated integration tests use a temporary in-memory MongoDB instance bound to localhost. They explicitly replace the inherited MongoDB URI before importing the app and use notification stubs. They do not target Atlas.

## Environment configuration

Set runtime variables through the local shell or deployment environment. This document lists names only and contains no secret values.

Required at runtime:

- `MONGODB_URI`
- `SESSION_SECRET` (at least 32 bytes)

The site origin variables below have production defaults in the application. Set them explicitly in Render so email links, generated asset URLs, and admin redirects always use the deployed sites:

| Variable | Production value |
| --- | --- |
| `PUBLIC_SITE_ORIGIN` | `https://pro-jenius-official-website-fronten.vercel.app` |
| `ADMIN_SITE_ORIGIN` | `https://pro-jenius-admin-website-frontend.vercel.app` |
| `PUBLIC_API_ORIGIN` | `https://projenius-official-website-backend.onrender.com` |
| `ADMIN_PANEL_URL` | `https://pro-jenius-admin-website-frontend.vercel.app/` |

Set these in the Render service's Environment settings. In the Vercel project settings, set `VITE_API_BASE_URL` to the backend URL and `VITE_SITE_URL` to the public site URL for the public website; set `VITE_ADMIN_API_URL` to the backend URL for the admin website. Redeploy each project after changing its environment variables. Local `.env` values can remain pointed at localhost for local development.

Optional or feature-specific names referenced by the backend:

- `PUBLIC_SITE_ORIGIN`
- `PUBLIC_API_ORIGIN` (public HTTPS backend origin used for generated article/course image URLs)
- `PORT`
- `TRUST_PROXY`
- `AUTH_DIAGNOSTICS`
- `GMAIL_USER`
- `GMAIL_APP_PASSWORD`
- `ADMIN_NOTIFICATION_EMAIL`
- `PRIVATE_UPLOAD_DIR`
- `COMPANY_LOGO_PATH`
- `PDF_UNICODE_FONT_PATH`
- `GOOGLE_OAUTH_CLIENT_ID` (OAuth client for the authorized Business Profile account)
- `GOOGLE_OAUTH_CLIENT_SECRET` (server-side secret; never expose to the frontend)
- `GOOGLE_OAUTH_REFRESH_TOKEN` (refresh token authorized for the `business.manage` scope)
- `GOOGLE_BUSINESS_LOCATION_NAME` (verified location resource, such as `accounts/123/locations/456`)
- `GOOGLE_REVIEWS_PROFILE_URL` (optional HTTPS link to the public review profile)
- `NODE_ENV`

`MONGODB_DB_NAME` is set by the isolated test harness but the application database name is intentionally fixed in source as `ProJeniusBackend`. `MONGOMS_RUNTIME_DOWNLOAD` is used by the test harness to prevent MongoDB binary downloads when a local test binary is unavailable.

### Google Business Profile reviews

The public `GET /api/reviews` endpoint reads reviews from the configured verified Business Profile location. Google OAuth credentials and location configuration are read only by the backend. If they are absent, the endpoint returns HTTP 503 with code `GOOGLE_REVIEWS_NOT_CONFIGURED`; other routes continue to work. A request without `pageToken` retrieves all provider pages (up to the module safety limit) and returns the complete collection for the website carousel. Supplying Google's `pageToken` returns one page with `nextPageToken`. The Google Business Profile API must be enabled and authorized for the verified ProJenius location before live reviews can be fetched.

To discover the account and location resource names for `GOOGLE_BUSINESS_LOCATION_NAME`, configure `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REFRESH_TOKEN` in the backend `.env`, then run `node scripts/googleBusinessLocations.js` from this backend directory. The utility exchanges the refresh token, lists accessible accounts and all their locations, and prints a numbered list. Select interactively or rerun with `node scripts/googleBusinessLocations.js --select <number>`; copy the printed `GOOGLE_BUSINESS_LOCATION_NAME=accounts/.../locations/...` assignment into `.env` yourself. It never prints credentials or modifies `.env`. Google Cloud must have approved/enabled the Business Profile Account Management and Business Information APIs, and the refresh token's Google account must have permission to manage the verified profile.

Successful full collections are cached in bounded process memory for five minutes, with concurrent refreshes coalesced. This avoids a database collection and repeated Google calls on a single backend process. With multiple backend instances, each process has its own cache and can refresh independently.

The receipt generator uses `PDF_UNICODE_FONT_PATH` when provided and otherwise checks its known local Noto, Windows Arial, and Linux Noto/DejaVu paths for rupee rendering. Ensure the chosen runtime has an approved Unicode font available.

## Local commands

From `projenius-backend`:

```powershell
npm.cmd run dev
npm.cmd test
npm.cmd run admin:create
```

`admin:create` is the guarded bootstrap for the first superadmin. It refuses to create a duplicate active superadmin and prompts interactively; do not use it to reset or replace existing credentials.

From the workspace root, the frontend development servers can be started separately:

```powershell
cd .\Website-Frontend
npm.cmd run dev
```

```powershell
cd .\projenius-admin
npm.cmd run dev
```

## Adding a feature safely

1. Confirm the domain is actually supported and define its request/response contract before adding files.
2. Add only the feature’s needed model, validation, service, controller, routes, and focused tests under `modules/<feature>/`.
3. Keep shared infrastructure in `shared/` only when it serves more than one feature; expose stable exports through that module’s `index.js`.
4. Register routes in `routes/index.js` without changing existing prefixes or methods.
5. Use the existing database connection; add the model to `initializeDatabaseModels()` so startup creates its declared collection/indexes without destructive changes.
6. Preserve authentication, CSRF, CORS, request limits, upload access controls, and the isolated test database setup.
7. Run the backend suite, syntax checks, and relevant frontend checks. Never point automated tests at Atlas or use real email recipients.
