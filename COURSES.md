# Courses and payments module

## Architecture and collections

Courses uses the existing backend connection and database `ProJeniusBackend`. The module creates these collections:

- `courses`: content, integer INR paise prices, image metadata, lifecycle, backward-compatible course-level schedule, versioned batches/sessions, private delivery instructions and internal cost.
- `course_enrollments`: student/contact details, selected batch snapshot, purchase terms acceptance, payment/enrollment state, independent approval state/history, notification status and a hashed expiring receipt token.
- `course_notification_jobs`: independent customer/admin delivery jobs, approval and schedule messages, attempts, retry timestamps and worker leases.
- `course_receipts`: immutable receipt metadata and checksum for the private generated PDF file.
- `course_payments`: one provider order, verified amount/state, gateway reference, reported fee and payment-attempt history.
- `course_refunds`: provider-reported refund events. The application does not initiate refunds.
- `course_audit_logs`: course changes and scheduled-publication audit events.
- `course_webhook_events`: provider event identifiers and payload hashes for replay control.

Declared indexes are created by the existing model-initialization path. Course slugs, enrollment references/request keys, payment order/payment IDs, refund IDs and webhook event IDs have uniqueness constraints where applicable. No database migration or existing collection is changed by this module.

## Lifecycle and publishing

Courses move among `draft`, `scheduled`, `published`, `unpublished` and `archived`. Only published courses whose `publishedAt` is not in the future appear in the public catalogue. Drafts and future schedules remain private. The running server scans MongoDB once at startup and once per minute for due courses. A conditional update makes publication idempotent; a pending-audit flag lets a later scan repair a missed publication audit. This is an in-process recurring scan, so publication pauses while the backend is stopped and catches up on restart. It is not a distributed scheduler; multiple backend instances may scan concurrently, with conditional updates preventing duplicate transitions.

Images accept PNG, JPEG and WebP files up to 5 MB, are signature-checked, assigned generated names and stored under `private_uploads/course_images`. Only images referenced by a published course can be fetched publicly. Replaced files are removed after the new metadata is saved.

## Permissions

The course permissions include `courses:list`, `courses:view`, `courses:create`, `courses:edit`, `courses:uploadImage`, `courses:schedule`, `courses:publish`, `courses:unpublish`, `courses:archive`, `courses:enrollments:view`, `courses:enrollments:details`, `courses:enrollments:approve`, `courses:enrollments:reject`, `courses:notifications:retry`, `courses:payments:view`, `courses:analytics:view`, `courses:reports:export` and `courses:refunds:view`. The existing Super Admin bypass remains in place. Regular-admin defaults were not broadened. Course endpoints check permissions on the backend. Internal course cost is returned only to Super Admins and administrators with analytics permission.

## Razorpay lifecycle

The backend creates orders using the course price stored in MongoDB (integer paise, INR). Checkout submissions require valid student details, an idempotency key, a valid open batch when batches exist, and acceptance of the current terms version (`live-training-v2` by default). The browser callback is not trusted: the backend verifies the order-bound HMAC signature, fetches the payment from Razorpay and checks order ID, amount, currency and captured state before marking payment received. Authorized and pending payments do not grant paid registration. A captured registration starts with separate `awaiting_approval` state. Admin approval/rejection is permission checked and audit logged; approval requires the selected schedule’s private instructions. There are no capacity counters or seat restrictions. Private course instructions are excluded from public course APIs and are sent only after approval. A signed webhook is verified against the untouched raw body, then deduplicated by provider event ID. Payment attempts remain recorded when an order has multiple attempts.

Configure these variable names in the runtime environment; no live values belong in this document:

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- Optional `COURSE_TERMS_VERSION` and `COURSE_TERMS_POLICY` to set the public, versioned terms text. The accepted version and policy snapshot are stored with each enrollment.
- Existing `GMAIL_USER`, `GMAIL_APP_PASSWORD` and `ADMIN_NOTIFICATION_EMAIL` for controlled, explicitly configured notification recipients.

Payment creation fails closed if the Razorpay key ID or secret is unavailable. Webhooks fail closed if the webhook secret is unavailable. Do not place the key secret or webhook secret in website variables. Configure the provider webhook URL as `/api/courses/payments/webhook` and subscribe to payment captured/authorized/failed and refund events. Until a webhook is created, copy the signing secret shown for that webhook into `RAZORPAY_WEBHOOK_SECRET` in the backend runtime configuration. Restart the backend, then verify signatures and event delivery using mocked fixtures first. Missing webhook configuration does not block unrelated application startup or checkout callback verification; webhook requests fail closed with HTTP 503 and a safe diagnostic. Use Razorpay test mode and synthetic data for manual validation.

Order creation does not request an explicit capture mode in its Orders API payload. Whether authorizations are automatically captured depends on the merchant's Razorpay Dashboard payment-capture setting; verify that setting in the Dashboard. The application activates enrollment and sends a paid receipt only after its backend fetch confirms provider status `captured`.

Course purchase terms are versioned and stored with the enrollment. The policy states that participant cancellations are non-refundable by default while preserving rights required by applicable law and service failure/cancellation. It needs review for the actual course delivery model and Indian consumer rules before live sale. There is no refund-initiation API or generic refund button; the admin Refunds area shows provider-reported refund events only. Signed Razorpay refund events update pending, failed and processed provider refund records, update payment/refund totals and add audit entries. No live refund execution has been tested or performed.

## Receipts and notifications

A verified payment creates one immutable receipt file and record. The confirmation response may issue a seven-day random bearer link; only its SHA-256 hash and expiry are stored. A throttled reissue endpoint matches both registration reference and registered email, responds identically for matching and non-matching requests, and queues a new link to the registered address. Admin receipt access remains permission protected. Customer and admin payment messages are independent jobs. A database-backed worker claims jobs with leases, retries transient failures with configurable bounded exponential backoff, recovers expired worker leases and records final failures. Approval/rejection and schedule-change/cancellation emails use the same queue. Manual admin retry requeues failed or unconfigured jobs without replaying payment/refund work. Provider delivery is at-least-once: a process crash after provider acceptance but before the job is marked sent may result in a duplicate email. Receipt files remain the original payment evidence after refunds; refund documentation is not generated automatically.

The application records payment and enrollment but does not deliver course lessons or provision student accounts. The website states that access delivery is coordinated by the ProJenius team. There are no seat counters, seat reservations or capacity-based approval restrictions. Courses support multiple batches and sessions, with batch-specific dates, timezone, registration windows, delivery mode and private instructions. Registration requires an open course and, when batches exist, an open future batch with an upcoming session. Schedule edits are captured in audit history and enqueue notices for approved participants assigned to changed batches. Private session instructions are omitted from public responses and sent only after admin approval. Keep a schedule marked cancelled or completed instead of removing it when registrations refer to it. Free enrollment, discounts, tax calculation, refund execution and a learning-management delivery integration are not implemented.

## Analytics definitions and verification

All amounts are stored as integer paise. Gross captured collections include only provider-captured payment orders; failed, pending and authorized orders are excluded. Refund-adjusted collections subtract provider-confirmed processed refund amounts. Estimated net subtracts only gateway fees reported by the provider. Per-course contribution estimate additionally subtracts entered internal cost and is not accounting profit. Missing fees/costs are not invented. Date filters use enrollment creation and payment-order creation timestamps; course lifecycle counts remain all-time.

Safe isolated test command from this directory:

```powershell
npm.cmd test
```

The integration test uses `mongodb-memory-server` on loopback, synthetic test keys, a fake Razorpay client, and deterministic PDF/email stubs. It removes `MONGODB_URI` before creating the in-memory server and explicitly checks the local host. It does not load the production `.env` file. The in-memory MongoDB executable must already be available; the test fails instead of falling back to another database.

For manual local testing, configure a separate local database and Razorpay test-mode credentials in the current shell only, configure customer/admin mailboxes that are controlled by the tester, start the backend and website, create and publish a synthetic course in Admin, and complete a test-mode purchase. Verify the enrollment reference and captured payment in Admin, email outcomes, and PDF receipt. Never use a production key or production database for this check.
