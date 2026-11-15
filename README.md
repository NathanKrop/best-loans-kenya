# DeniCash

A Kenyan loan-application app with account registration, email verification, profile capture and loan-request storage. Registration collects date of birth, county and monthly income once; the dashboard displays the saved details and calculates the age-based request range. The customer site uses the configured backend; it has no browser-local mock account or application mode. Registration is free. The backend includes a sandbox-only manual offer and M-Pesa workflow. Production application-fee collection is opt-in and disabled by default; production lending and disbursements are unavailable.

## Project structure

- `frontend/index.html`: public site and API-backed customer account flow.
- `admin/index.html`: status page; application decisions are currently available through the authenticated sandbox API only.
- `backend/`: Node API and PostgreSQL schema.

## Run locally

1. Copy `backend/.env.example` to `backend/.env` and set database and secret values.
2. From `backend/`, run `docker compose up -d`, `npm install`, `npm run db:generate`, `npm run db:migrate`, then `npm run dev`.
3. From the project root, run `python -m http.server 8000`.
4. Open `http://localhost:8000/frontend/` for the customer site. Admin review is available through the authenticated sandbox API only.

The API defaults to `http://localhost:3000/api` in local development and uses the same-origin `/api` path on the Vercel deployment. Email OTP delivery uses Resend; configure `RESEND_API_KEY` and `EMAIL_FROM` in the backend environment with a verified sender domain. For local development, set `DEV_OTP_CODE` to use a fixed code without sending email; this bypass is disabled in production.

Registration uses email for account sign-in and email OTP verification. An unverified account that signs in is returned to the email confirmation step, where it can request another code. After email verification, customers complete the Assurance step before reaching the dashboard. They choose a Kenyan ID card or passport, upload the ID card's front and back or the passport photo/biographical page, upload a selfie, and provide a guarantor's full name and Kenyan phone number. Supported image formats are JPEG, PNG, and WebP (up to 8 MB each).

Assurance documents are sent to a private Supabase Storage bucket; the database stores only private object paths and submission metadata. Create a private bucket named `assurance-documents` (or set `SUPABASE_ASSURANCE_BUCKET`) with an 8 MB file limit and JPEG, PNG, and WebP MIME types. Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the backend only; never expose the service-role key to the browser. The assurance table has row-level security enabled without public policies. The app does not automatically verify identity or perform face matching; submissions are not approvals. Publish an appropriate privacy notice and obtain legal/data-protection review before collecting real customer identity documents.

The phone number is collected during email verification and stored without phone verification. Run `npm run db:deploy` from `backend/` after configuring the database to apply all migrations.

Loan request limits are age-based: applicants aged 18–25 may request KES 10,000–30,000, while applicants over 25 may request KES 30,000–200,000. These are request limits only; they do not represent eligibility decisions, offers, or approvals. Applications receive a confirmation that makes clear the request is not an approval or offer. The sandbox workflow calculates 10% flat interest for a written offer and sets the due date to the requested term after confirmed disbursement; it does not request advance interest payments. Loan amounts must not be assigned randomly; the approved amount must be assessed and included in the specific written offer.

## Application fee

Continuing after submitting a loan application requests a 10% application fee based on the requested amount. The fee is separate from any 10% flat interest in a future written offer and does not guarantee approval or disbursement. The full fee is refunded if the application is rejected or withdrawn; refunds are handled manually to the original M-Pesa number. The authenticated STK endpoint is `POST /api/payments/production/application-fee`; customers can check its status at `GET /api/payments/production/application-fee/:paymentId/status`. The UI checks `GET /api/payments/production/application-fee/config` and disables Continue unless the production setup is ready. Collection is disabled unless `MPESA_ENV=production` and `MPESA_APPLICATION_FEE_ENABLED=true`; configure the live Till (`MPESA_SHORTCODE=3584917`, `MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline`), Daraja credentials, callback token, and publicly reachable HTTPS callback URL privately on the backend. Apply migrations before enabling the endpoint. Production lending, disbursement, automated refunds and transaction reconciliation are not implemented. Do not enable real collection until manual refunds, customer support and applicable legal/licensing review are operational.

## M-Pesa sandbox test flow

The backend includes a sandbox-only STK test-payment endpoint at `POST /api/payments/sandbox/stk-push`, a callback at `POST /api/payments/mpesa/callback`, and authenticated list/status endpoints at `GET /api/payments/sandbox/me` and `GET /api/payments/sandbox/:paymentId/status`. These routes are disabled by default; enable them only for sandbox testing by setting `MPESA_ENV=sandbox` and `MPESA_SANDBOX_TEST_MODE=true` with valid Daraja sandbox credentials and a publicly reachable HTTPS callback URL. The STK route accepts test amounts up to KES 1,000 and creates records marked `SANDBOX_TEST`; it is not connected to a loan balance, repayment schedule, or accepted offer. Callback and status-query results are confirmed with Daraja's transaction-query endpoint before updating a payment record. Requests require a signed-in customer session.

The callbacks must be reachable over public HTTPS for Daraja to deliver them. For sandbox testing, use Safaricom's test shortcode `174379`, the sandbox consumer key, consumer secret, and passkey from the Daraja developer portal, and `MPESA_TRANSACTION_TYPE=CustomerPayBillOnline`. Copy `backend/.env.example` to `backend/.env` and set a long random callback token plus a public HTTPS callback URL. Keep all Daraja credentials on the backend. This sandbox test flow must not be used to collect or disburse real funds. Production loan disbursement and repayment remain unavailable.

## Sandbox loan offer lifecycle

The sandbox workflow is opt-in and fails closed unless `MPESA_ENV=sandbox`, `MPESA_SANDBOX_TEST_MODE=true`, and `LOAN_WORKFLOW_SANDBOX_MODE=true`. It provides authenticated customer offer, acceptance, test disbursement and repayment routes, plus admin review routes. Configure `ADMIN_EMAILS` as a comma-separated allowlist of already registered, email-verified operator accounts. Protect the Daraja callback URLs with a long random `MPESA_CALLBACK_TOKEN`; use the same token in the configured HTTPS callback URLs. B2C disbursement additionally requires Daraja sandbox initiator credentials and a sandbox `MPESA_SECURITY_CREDENTIAL`.

An operator can review pending applications with `GET /api/admin/loan-applications`, issue a written 10% flat-interest offer with `POST /api/admin/loan-applications/:applicationId/offer`, or reject an application with `POST /api/admin/loan-applications/:applicationId/reject`. Customers can view offers with `GET /api/loans/offers/me`, accept one to request sandbox B2C disbursement, and request repayment by STK push only after disbursement is confirmed. The repayment amount is read from the user's active loan offer on the server; clients cannot supply or change it. A pending repayment is recorded before the STK request, and the callback/status query can transition it once to success, failure, cancellation, or timeout. Only confirmed success marks the loan repaid. The dashboard displays a visible “Sandbox mode — no real money” notice. No interest is requested before disbursement.

This workflow is not suitable for real lending or money movement. It has no production approval authorization model, manual reconciliation tools, robust settlement reconciliation, or legal/compliance review. Do not set production Daraja credentials for these endpoints, and do not describe sandbox results as real funds.

## Deploy the app to Vercel

Set the Vercel project's Root Directory to the repository root (`.`). The Vercel build uses the root `index.mts` Express entry point for the API, and publishes `frontend/` and `admin/` as static assets. The site root redirects to `/frontend/`.

Before deploying, provision Supabase PostgreSQL. Configure `DATABASE_URL` with Supabase's transaction-pooler connection string (port 6543, with `pgbouncer=true`) and `DIRECT_URL` with its session-pooler/direct connection string for Prisma migrations. Then apply the migrations with `npm run db:deploy` from `backend/`. Configure `JWT_SECRET`, `OTP_HASH_SECRET`, `NATIONAL_ID_ENCRYPTION_KEY`, `FRONTEND_ORIGIN=https://www.denicash.com`, `RESEND_API_KEY`, and `EMAIL_FROM` as Vercel environment variables. Keep credentials private and set them in Vercel, not in source control. Configure a verified email sender/domain with Resend. The API and account/application paths will not work until required environment variables, database and migrations are ready.

This deployment does not make the app ready to lend. The sandbox API workflow does not provide production admin tooling, affordability assessment, manual exceptions, settlement reconciliation, compliant written-offer acceptance, customer receipts or production M-Pesa payouts. Application-fee collection is not activated in this workspace; production lending and disbursement remain unavailable.

Do not enable application-fee collection until manual refunds, customer support, company/licensing details and applicable legal review are operational and published.

## What remains before this can operate as a loan app

- Complete the customer-facing terms, privacy notice, consent and company/licensing/contact details.
- Complete the affordability assessment, underwriting, production decisioning, borrower acceptance and auditable decision records.
- Implement compliant production loan disbursement, repayment schedules, collections, reconciliation, customer receipts and support processes.
- Build an operational admin panel for the authenticated sandbox review APIs and extend its access controls, audit trails and monitoring before any production use.
- Complete security, data-protection, backup, incident-response and production deployment work, then validate the end-to-end flow.
- Obtain legal advice on applicable Kenyan digital-credit licensing and data-protection obligations, and confirm the operating model with relevant authorities.

Never present a submitted request as an approval or promise of funds. Show the full cost and repayment schedule in a written offer before a borrower accepts it. Do not collect loan repayments until the relevant lending and payment systems are implemented and reviewed.
