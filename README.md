# Best Loans Kenya

A Kenyan loan application prototype with a server-backed user flow and a separate M-Pesa API. The admin panel is still demo-only, and the platform is not ready for production lending. A KES 250 registration fee does not guarantee loan approval.

## Project structure

```
best-loans-kenya/
  frontend/index.html      Public site + customer account flow; use ?demo=1 for the local mock
  admin/index.html         Demo admin panel (overview, users, payments, applications, audit log)
  shared/demo-store.js     Browser-local mock data shared by public and admin pages
  shared/demo-store.test.js Shared-store regression tests
  docs/BACKEND_PROMPT.md   Full prompt for building the backend (Node, PostgreSQL, M-Pesa STK Push)
  backend/                 Node API, PostgreSQL schema and Daraja integration
  .vscode/extensions.json  Recommended VS Code extensions
```

## Run it in VS Code

1. Open the `best-loans-kenya` folder in VS Code (File > Open Folder).
2. Set up and start the backend using the instructions below.
3. In a separate terminal at the project root, run `python -m http.server 8000`.
4. Open `http://localhost:8000/frontend/` for the API-backed user flow or `http://localhost:8000/frontend/?demo=1` for the mock.
5. Open `http://localhost:8000/admin/` for the admin demo.

The API defaults to `http://localhost:3000/api`; set `window.BEST_LOANS_API` before the frontend script when deploying to a different API URL.

## Demo behaviour

- With `?demo=1`, public registrations, profiles, payments and loan applications use mock data stored in browser local storage and are shared with the admin page.
- Admin sample users and transactions are generated mock rows; they are separate from public demo records.
- Demo sign-up OTP accepts any 6 digits, and the demo M-Pesa payment is simulated (3 second wait).
- Admin login: any email and a password of 6+ characters.
- "Copy CSV" in the admin copies text to the clipboard. The real backend will serve a downloadable CSV.
- The public calculator only illustrates a requested amount and period; it does not calculate interest or promise loan terms, approval or disbursement.

Do not use the prototype, demo mode or admin demo to collect real customer information or money. The demo payment is not an M-Pesa transaction. Company, licensing, contact and policy details must be verified and published before launch.

## Backend development

The backend and public account flow support registration, OTP verification, login, profile and loan-application storage, Daraja STK Push initiation, payment status/history, and callback verification using STK Query. The API requires PostgreSQL, SMS delivery credentials for Africa's Talking, and M-Pesa Daraja credentials.

1. Install Node.js 20 or newer and Docker.
2. In `backend/`, copy `.env.example` to `.env`. Set strong random values for `JWT_SECRET`, `OTP_HASH_SECRET`, and a 32-byte `NATIONAL_ID_ENCRYPTION_KEY` encoded as 64 hex characters. Add provider credentials obtained directly from their official portals. Never put secrets in frontend files or send them in chat.
3. Start the local database with `docker compose up -d` from `backend/`.
4. Run `npm install`, `npm run db:generate`, and `npm run db:migrate` from `backend/`.
5. Run `npm run dev`. The API health check is at `http://localhost:3000/health`.
6. For STK callbacks, expose the API using an HTTPS tunnel during sandbox development and set that public HTTPS URL as `MPESA_CALLBACK_URL`.
7. Run backend checks with `npm test`, `npm run build`, and `npm audit`.

For local development without SMS credentials, you may set `DEV_OTP_CODE` to a known six-digit value in `.env`; this bypass is disabled in production. The admin panel is not connected to the API. Loan assessment, decisions, offers, disbursements, repayment servicing, confirmation SMS, admin API/authentication, production deployment and real credential testing remain to be completed. Never accept real payments until those steps and applicable regulatory checks are complete.

Run the shared-store regression tests with `node --test shared/demo-store.test.js`.

## Next steps

1. Finish customer-facing content and onboarding, and publish verified company, licensing, data-protection and contact details plus the Terms, Privacy and Refund policies.
2. Build loan assessment, decisioning, written offers, acceptance, M-Pesa disbursement, repayment schedules and reconciliation in the backend.
3. Keep the admin panel as a demo until the customer frontend and lending backend are complete; then connect admin operations, monitoring and production support.

## Before going live

- Get legal advice on licensing (CBK Digital Credit Provider rules) and on charging an upfront fee.
- Register with the Office of the Data Protection Commissioner.
- Keep the "does not guarantee loan approval" notice visible wherever the KES 250 fee appears.
- Obtain Safaricom production approval and credentials; verify callbacks over HTTPS and complete end-to-end testing before accepting real payments.
