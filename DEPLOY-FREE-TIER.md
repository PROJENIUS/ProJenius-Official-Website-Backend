# ProJenius on free hosting — setup checklist

Backend on **Render (free)**, website and admin on **Vercel (free)**, database on **MongoDB Atlas (free M0)**, email via **Gmail**, payments via **Razorpay**.

## 1. Render (backend) → Environment

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `1` (needed for secure login cookies and per-visitor rate limits behind Render) |
| `MONGODB_URI` | Atlas connection string |
| `SESSION_SECRET` | long random text (at least 32 characters) |
| `ADMIN_SITE_ORIGIN` | `https://pro-jenius-admin-website-frontend.vercel.app` |
| `PUBLIC_SITE_ORIGIN` | the live website address (Vercel URL, later `https://projenius.in`) |
| `PUBLIC_API_ORIGIN` | `https://projenius-official-website-backend.onrender.com` |
| `ADMIN_PANEL_URL` | optional; the admin link in emails (defaults to the Vercel admin URL) |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Gmail address + a fresh 16-letter app password |
| `ADMIN_NOTIFICATION_EMAIL` | where new-enquiry / payment emails go |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | from the Razorpay dashboard |
| `RAZORPAY_WEBHOOK_SECRET` | from the webhook you create (step 4) |
| `KEEPALIVE_TOKEN` | same value as in the local `.env` |

Do not set `PORT` on Render; Render provides it.

## 2. Vercel

- **Admin project:** remove `VITE_ADMIN_API_URL` (or set it to `same-origin`). `vercel.json` forwards `/api/*` to Render, so the login cookie belongs to the admin site and works in every browser, including Safari and incognito.
- **Website project:** `VITE_API_BASE_URL` = `https://projenius-official-website-backend.onrender.com`.
- Redeploy both after changing variables (Vite reads them at build time).

## 3. MongoDB Atlas

- Network Access: Render free has no fixed IP, so allow `0.0.0.0/0` and use a long random database password.
- Files are stored in the database (course images, enquiry attachments, resumes, receipts) because Render free erases its disk on every restart. Keep an eye on the 512 MB free limit (Atlas → Metrics).

## 4. Razorpay webhook

Dashboard → Webhooks → Add: URL `https://projenius-official-website-backend.onrender.com/api/courses/payments/webhook`, events `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed`. Copy the secret into `RAZORPAY_WEBHOOK_SECRET`.

## 5. cron-job.org (free) — two jobs

1. **Stay awake (no 50-second cold starts):** `GET https://projenius-official-website-backend.onrender.com/api/health` every **10 minutes**. One always-on service uses about 730 of Render's 750 free hours a month.
2. **Database keep-alive:** `GET https://projenius-official-website-backend.onrender.com/api/keepalive` every **7 days**, with request header `X-Keepalive-Token: <KEEPALIVE_TOKEN>`. Writes one "ProJenius" entry (collection `system_keepalive`) so the free Atlas cluster is never paused. The backend also writes one itself every 15 days while awake, and `npm run keepalive` writes one by hand.

## 6. After deploying, check

- `…/api/health` → `{"status":"ok","database":"available"}`
- Admin: sign in, refresh the page, still signed in.
- Website: submit a contact enquiry → both emails arrive; Admin → Enquiries shows it.
- A test payment in Razorpay test mode for a course and a career guidance call.
