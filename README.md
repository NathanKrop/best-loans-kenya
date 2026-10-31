# Best Loans Kenya

A Kenyan loan application prototype with account registration, phone verification, profile capture and loan request storage. Registration is free. The admin panel remains demo only, and the platform is not ready for production lending.

## Project structure

- `frontend/index.html`: public site and customer account flow; add `?demo=1` for browser-local mock data.
- `admin/index.html`: demo admin panel.
- `shared/demo-store.js`: browser-local mock data shared by public and admin pages.
- `backend/`: Node API and PostgreSQL schema.

## Run locally

1. Copy `backend/.env.example` to `backend/.env` and set database and secret values.
2. From `backend/`, run `docker compose up -d`, `npm install`, `npm run db:generate`, `npm run db:migrate`, then `npm run dev`.
3. From the project root, run `python -m http.server 8000`.
4. Open `http://localhost:8000/frontend/` for the API-backed flow, `http://localhost:8000/frontend/?demo=1` for mock mode, or `http://localhost:8000/admin/` for the admin demo.

The API defaults to `http://localhost:3000/api`. Email OTP delivery uses Resend; configure `RESEND_API_KEY` and `EMAIL_FROM` in `backend/.env`. For local development, set `DEV_OTP_CODE` to use a fixed code without sending email; this bypass is disabled in production. The demo OTP accepts any six digits. Demo accounts and loan applications are simulated. The demo assurance step accepts local file selections only: assurance details are not saved; identity images are not uploaded, retained, or verified; and selecting files never approves an account or loan. Do not enter real personal information.

Registration uses email for account sign-in and email OTP verification. The phone number is collected on the verification step and stored without phone verification. Run `npm run db:deploy` from `backend/` after configuring the database to apply the email-registration migration.

Loan request limits are age-based: applicants aged 18–25 may request KES 1,000–30,000, while applicants over 25 may request KES 30,000–200,000. These limits validate request amounts only; they do not represent eligibility decisions, offers, or approvals.

## Deploy the static demo to Vercel

Set the Vercel project's Root Directory to the repository root (`.`). The Vercel build publishes only `frontend/`, `admin/` and `shared/`; the site root redirects to the simulated frontend at `/frontend/?demo=1`. This does not deploy the backend API. All sign-up, verification and loan application activity in demo mode is simulated and must not be used for real customer data or payments.

Do not use the prototype, demo mode or admin demo to collect real customer information or money. Company, licensing, contact and policy details must be verified and published before launch.

## What remains before this can operate as a loan app

- Complete the customer-facing terms, privacy notice, consent and company/licensing/contact details.
- Build affordability assessment, underwriting, decisioning, written offers, borrower acceptance and auditable decision records.
- Implement compliant loan disbursement, repayment schedules, collections, reconciliation, customer receipts and support processes.
- Connect the admin panel to authenticated backend APIs with roles, audit trails and operational monitoring.
- Complete security, data-protection, backup, incident-response and production deployment work, then validate the end-to-end flow.
- Obtain legal advice on applicable Kenyan digital-credit licensing and data-protection obligations, and confirm the operating model with relevant authorities.

Never present a submitted request as an approval or promise of funds. Show the full cost and repayment schedule in a written offer before a borrower accepts it. Do not collect loan repayments until the relevant lending and payment systems are implemented and reviewed.
