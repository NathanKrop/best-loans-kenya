# DeniCash

A Kenyan loan-application app with account registration, email verification, profile capture and loan-request storage. Registration is free. The current backend supports these account and request flows when configured; owner-admin decisions, written offers, repayment schedules and live payments/disbursements are not implemented. Do not collect customer money or promise a loan through this app.

## Project structure

- `frontend/index.html`: public site and customer account flow; add `?demo=1` for explicit browser-local mock data.
- `admin/index.html`: demo admin panel.
- `shared/demo-store.js`: browser-local mock data shared by public and admin pages.
- `backend/`: Node API and PostgreSQL schema.

## Run locally

1. Copy `backend/.env.example` to `backend/.env` and set database and secret values.
2. From `backend/`, run `docker compose up -d`, `npm install`, `npm run db:generate`, `npm run db:migrate`, then `npm run dev`.
3. From the project root, run `python -m http.server 8000`.
4. Open `http://localhost:8000/frontend/` for the API-backed flow, `http://localhost:8000/frontend/?demo=1` for mock mode, or `http://localhost:8000/admin/` for the admin demo.

The API defaults to `http://localhost:3000/api` in local development and uses the same-origin `/api` path on the Vercel deployment. Email OTP delivery uses Resend; configure `RESEND_API_KEY` and `EMAIL_FROM` in the backend environment. For local development, set `DEV_OTP_CODE` to use a fixed code without sending email; this bypass is disabled in production. The demo OTP accepts any six digits. Demo accounts and loan applications are simulated. The demo assurance step accepts local file selections only: assurance details are not saved; identity images are not uploaded, retained, or verified; and selecting files never approves an account or loan. Do not enter real personal information.

Registration uses email for account sign-in and email OTP verification. An unverified account that signs in is returned to the email confirmation step, where it can request another code. The phone number is collected on the verification step and stored without phone verification. Run `npm run db:deploy` from `backend/` after configuring the database to apply the email-registration migration.

Loan request limits are age-based: applicants aged 18–25 may request KES 10,000–30,000, while applicants over 25 may request KES 30,000–200,000. These are request limits only; they do not represent eligibility decisions, offers, or approvals. The proposed flat 10% total interest is not currently a loan offer: loan term and repayment dates are undecided. Loan amounts must not be assigned randomly; any future amount must be assessed and included in a specific written offer.

## M-Pesa sandbox scaffold

The backend includes a sandbox-only STK test-payment endpoint at `POST /api/payments/sandbox/stk-push`, a callback at `POST /api/payments/mpesa/callback`, and an authenticated status endpoint at `GET /api/payments/sandbox/:paymentId/status`. These routes are disabled by default; enable them only for sandbox testing by setting `MPESA_ENV=sandbox` and `MPESA_SANDBOX_TEST_MODE=true` with valid Daraja sandbox credentials. The STK route accepts test amounts up to KES 1,000 and creates records marked `SANDBOX_TEST`; it is not connected to a loan balance, repayment schedule, or accepted offer. Callback and status-query results are confirmed with Daraja's transaction-query endpoint before updating a payment record.

The callback must be reachable over public HTTPS for Daraja to deliver callbacks. Customer deposits/upfront fees and borrower payouts are not enabled; no B2C disbursement endpoint exists, and production payments remain unavailable. The Till is configured as a Buy Goods destination in the example environment, but that does not enable collection. Do not use this scaffold to collect real payments.

## Deploy the app to Vercel

Set the Vercel project's Root Directory to the repository root (`.`). The Vercel build uses the root `index.mts` Express entry point for the API, and publishes `frontend/`, `admin/` and `shared/` as static assets. The site root redirects to `/frontend/` (API mode); demo mode is available only when explicitly opened with `?demo=1`.

Before deploying, provision Supabase PostgreSQL, apply the migrations with `npm run db:deploy` from `backend/`, and configure Vercel environment variables: `DATABASE_URL`, `JWT_SECRET`, `OTP_HASH_SECRET`, `NATIONAL_ID_ENCRYPTION_KEY`, `FRONTEND_ORIGIN=https://www.denicash.com`, `RESEND_API_KEY`, and `EMAIL_FROM`. Use the Supabase connection settings appropriate for serverless deployments. Keep credentials private and set them in Vercel, not in source control. Configure the live email sender/domain with Resend. The API and account/application paths will not work until required environment variables, database and migrations are ready.

This deployment does not make the app ready to lend. The admin review interface and secure admin decision API, affordability assessment, written offers, repayment term and schedule, receipts, reconciliation and M-Pesa borrower payouts still need implementation and review. Live collection and disbursement remain disabled.

Do not use the prototype, demo mode or admin demo to collect real customer information or money. Company, licensing, contact and policy details must be verified and published before launch.

## What remains before this can operate as a loan app

- Complete the customer-facing terms, privacy notice, consent and company/licensing/contact details.
- Complete the affordability assessment, underwriting, decisioning, written offers, borrower acceptance and auditable decision records.
- Implement compliant loan disbursement, repayment schedules, collections, reconciliation, customer receipts and support processes.
- Connect the admin panel to authenticated backend APIs with roles, audit trails and operational monitoring.
- Complete security, data-protection, backup, incident-response and production deployment work, then validate the end-to-end flow.
- Obtain legal advice on applicable Kenyan digital-credit licensing and data-protection obligations, and confirm the operating model with relevant authorities.

Never present a submitted request as an approval or promise of funds. Show the full cost and repayment schedule in a written offer before a borrower accepts it. Do not collect loan repayments until the relevant lending and payment systems are implemented and reviewed.
