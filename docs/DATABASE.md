# ProJenius database map

MongoDB database: **`ProJeniusBackend`** (set in `src/config/database.js`).
Collections are named `<area>_<thing>`, so each one shows which part of the
website or admin panel owns it. Uploaded images are stored in GridFS
(`media.files` + `media.chunks`) and referenced by id from the collections below.

| Area | Collection | What it holds | Website / admin page |
| --- | --- | --- | --- |
| Admin | `admins` | Admin and staff accounts (hashed passwords, role, permissions) | Admin → Users & Activity |
| Admin | `admin_invitations` | Pending account invitations | Admin → Users & Activity |
| Admin | `admin_password_resets` | One-time password reset tokens (hashed) | Admin sign-in |
| Admin | `admin_audit_events` | Every sign-in and admin change | Admin → Users & Activity |
| Admin | `sessions` | Signed-in admin sessions (connect-mongo) | Admin panel |
| Website | `website_home_hero` | Home page hero slides | Home → Admin → Page Heroes → Home |
| Website | `website_page_heroes` | Hero content of other pages, one document per page | About, Software, PCB, Courses, Career Guidance, Workshops, Products, News, Join Our Team |
| Website | `website_legal_documents` | Terms, Privacy Policy, Cookie Policy, Live Training Refund Policy | Footer legal pages → Admin → Legal pages |
| Enquiries | `enquiries` | Contact-form enquiries with attachments | Contact → Admin → Enquiries |
| Careers | `careers_job_openings` | Job openings (draft / open / closed) | Join Our Team → Admin → Job Openings |
| Careers | `careers_job_applications` | Job applications with resumes | Join Our Team → Apply → Admin → Enquiries → Career applications |
| Courses | `courses` | Courses, batches, prices, cover images | Courses → Admin → Courses |
| Courses | `course_enrollments`, `course_payments`, `course_receipts`, `course_refunds` | Registrations, Razorpay payments, receipts, refunds | Course checkout → Admin → Courses |
| Courses | `course_policies`, `course_common_faqs`, `course_audit_logs`, `course_notification_jobs`, `course_webhook_events` | Older checkout policy, shared FAQs, change log, email queue, Razorpay webhooks | Admin → Courses |
| Guidance | `guidance_bookings`, `guidance_settings` | Career guidance call bookings and settings | Career Guidance → Admin → Career Guidance |
| News & newsletter | `content_articles` | News and blog posts (also the home Highlights cards) | News & Insights → Admin → News & Insights |
| News & newsletter | `newsletter_subscribers`, `newsletter_campaigns`, `newsletter_deliveries`, `publication_events` | Subscribers, announcement emails and their delivery | Footer newsletter → Admin → Newsletter |
| System | `system_keepalive` | Keep-alive ping record for the free hosting tier | — |
| Media | `media.files`, `media.chunks` | All uploaded images (GridFS) | Every admin image upload |

## Renamed on 27 Nov 2026

These were renamed to follow the pattern. All of them were **empty** in the live
database when renamed, so no data had to move. After the new backend is live,
the old empty collections can be dropped:
`admininvitations`, `passwordresets`, `job_applications`, `home_hero`,
`page_heroes`, `legal_documents`.

Collections that already hold data (`enquiries`, `content_articles`, `courses`
and the `course_*`, `newsletter_*` and `guidance_*` collections) keep their
names; they already follow the pattern or are clear on their own.
