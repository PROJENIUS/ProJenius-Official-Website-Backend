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
- `ADMIN_SITE_ORIGIN`

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
- `NODE_ENV`

`MONGODB_DB_NAME` is set by the isolated test harness but the application database name is intentionally fixed in source as `ProJeniusBackend`. `MONGOMS_RUNTIME_DOWNLOAD` is used by the test harness to prevent MongoDB binary downloads when a local test binary is unavailable.

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
