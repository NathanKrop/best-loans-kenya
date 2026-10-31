# PROJECT PROMPT: "Best Loans Kenya" – BACKEND API

## 1. ROLE
You are a senior backend engineer experienced in Kenyan fintech, M-Pesa Daraja integrations, and secure API design. Write production-quality, well-commented, tested code. Make sensible decisions without asking unnecessary questions, and list your assumptions at the end of each phase.

## 2. CONTEXT
The frontend is finished (mock data). Users: sign up → verify phone by SMS OTP → pay a one-time KES 250 registration fee via M-Pesa STK Push → dashboard unlocks → complete profile (KYC) → apply for loans → track status. Admins manage users, payments and applications.
Business rule: the fee does NOT guarantee loan approval. Never imply otherwise in any API message or SMS.

## 3. TECH STACK
- Node.js 20 + Express + TypeScript
- PostgreSQL 15 with Prisma ORM (migrations + seed script)
- Zod for request validation
- Auth: JWT access token (15 min) + refresh token (7 days) in httpOnly, Secure, SameSite cookies; argon2 password hashing
- Redis (optional but preferred) for rate limiting, OTP throttling and idempotency keys
- SMS: Africa's Talking API
- M-Pesa: Safaricom Daraja API (sandbox first, production via env switch)
- Logging: pino; Testing: Vitest + Supertest; API docs: OpenAPI/Swagger at /docs
- Docker + docker-compose (api, postgres, redis); .env.example with every variable

## 4. DATABASE SCHEMA (Prisma models)
- User: id (uuid), fullName, phone (unique, stored as 2547XXXXXXXX or 2541XXXXXXXX), email?, passwordHash, phoneVerifiedAt?, registrationPaidAt?, status (ACTIVE | SUSPENDED), createdAt, updatedAt
- OtpCode: id, userId, codeHash, purpose (VERIFY_PHONE | RESET_PASSWORD), expiresAt (5 min), attempts, consumedAt?
- Profile: userId (1:1), nationalIdEncrypted, nationalIdLast3, dateOfBirth, county, employmentStatus, monthlyIncomeRange, nextOfKinName, nextOfKinPhone
- Payment: id, userId, purpose (REGISTRATION_FEE), amount (int, KES), phone, merchantRequestId, checkoutRequestId (unique), status (PENDING | SUCCESS | FAILED | CANCELLED | TIMEOUT), resultCode?, resultDesc?, mpesaReceiptNumber? (unique), transactionDate?, rawCallback (jsonb), createdAt, updatedAt
- LoanApplication: id, userId, amount, periodDays, purpose, status (PENDING | APPROVED | REJECTED), decidedById?, decidedAt?, decisionNote?, createdAt
- Admin: id, email (unique), passwordHash, role (SUPER_ADMIN | REVIEWER | SUPPORT), lastLoginAt
- AuditLog: id, actorType (USER | ADMIN | SYSTEM), actorId, action, entity, entityId, metadata (jsonb), ip, createdAt
- RefreshToken: id, userId/adminId, tokenHash, expiresAt, revokedAt?
Add indexes on phone, checkoutRequestId, mpesaReceiptNumber, status, createdAt.

## 5. M-PESA STK PUSH (CRITICAL – implement exactly)
Config (env): MPESA_ENV (sandbox|production), CONSUMER_KEY, CONSUMER_SECRET, SHORTCODE, PASSKEY, CALLBACK_URL (public HTTPS), TRANSACTION_TYPE (CustomerPayBillOnline | CustomerBuyGoodsOnline), REGISTRATION_FEE=250.
Base URLs: sandbox https://sandbox.safaricom.co.ke, production https://api.safaricom.co.ke

1. Access token: GET /oauth/v1/generate?grant_type=client_credentials with Basic auth (key:secret). Cache in memory/Redis until ~5 minutes before expiry.
2. Initiate: POST /mpesa/stkpush/v1/processrequest with BusinessShortCode, Password = base64(Shortcode + Passkey + Timestamp), Timestamp (YYYYMMDDHHmmss, Africa/Nairobi), TransactionType, Amount (250), PartyA (customer phone), PartyB (shortcode/till), PhoneNumber, CallBackURL, AccountReference ("BLK-" + short user ref), TransactionDesc ("Registration fee").
3. Before initiating: user must be authenticated and phone-verified, must not already be paid, and must not have a PENDING payment younger than 90 seconds (return that pending payment instead). Normalize phone to 254 format and validate.
4. Save Payment as PENDING with MerchantRequestID and CheckoutRequestID from the response. Return { paymentId, checkoutRequestId, status: "PENDING" } to the client.
5. Callback: POST /api/payments/mpesa/callback (public). Parse Body.stkCallback: ResultCode 0 = success; read Amount, MpesaReceiptNumber, TransactionDate, PhoneNumber from CallbackMetadata. Look up by CheckoutRequestID. Always respond HTTP 200 with { ResultCode: 0, ResultDesc: "Accepted" } quickly, then process.
6. Callback security: Daraja callbacks are unsigned, so never trust them blindly. Verify (a) CheckoutRequestID exists and is PENDING, (b) amount equals the expected fee, (c) receipt number is not already used, and (d) confirm through the STK Query API (POST /mpesa/stkpushquery/v1/query) before marking SUCCESS. Optionally restrict callback route by an unguessable path token in the CALLBACK_URL.
7. Idempotency: processing the same callback twice must not double-apply. Use a DB transaction and unique constraints on checkoutRequestId and mpesaReceiptNumber.
8. On success: set Payment SUCCESS, set User.registrationPaidAt, write AuditLog, send confirmation SMS ("Payment of KES 250 received. Receipt XXXX. This does not guarantee loan approval.").
9. Failure codes: map common ResultCodes (1032 cancelled by user, 1037 timeout, 2001 wrong PIN, 1 insufficient funds) to friendly messages the frontend can show, and set the matching status.
10. Reconciliation job (cron every 2 min): for PENDING payments older than 2 minutes, call STK Query and update; mark TIMEOUT after 10 minutes.
11. Payment status endpoint for frontend polling: GET /api/payments/:id/status (owner only).
12. Sandbox tooling: provide a script that simulates a callback locally for tests, plus notes on using ngrok for CALLBACK_URL.

## 6. API ENDPOINTS (prefix /api, JSON, consistent error format { error: { code, message, fields? } })
Auth:
- POST /auth/register {fullName, phone, password, consent:true} → creates user, sends OTP
- POST /auth/verify-otp {phone, code}
- POST /auth/resend-otp (max 3 per hour per phone)
- POST /auth/login {phone, password}, POST /auth/refresh, POST /auth/logout
- POST /auth/forgot-password, POST /auth/reset-password
Payments:
- POST /payments/registration/stk-push {phone?}
- GET /payments/:id/status
- POST /payments/mpesa/callback (public)
- GET /payments/me (history + receipts)
Profile:
- GET /profile/me, PUT /profile/me (Zod validation: national ID 7–8 digits, county from allowed list, etc.)
Loans (require registrationPaidAt AND completed profile):
- POST /loans/apply {amount 1000–50000, periodDays 7–90, purpose}
- GET /loans/me
Admin (separate login, RBAC):
- POST /admin/auth/login
- GET /admin/stats (users, paid users, revenue, pending/approved/rejected counts, last 30 days series)
- GET /admin/users (search, filter, paginate; masked phone/ID), GET /admin/users/:id, PATCH /admin/users/:id/status
- GET /admin/payments (filters: status, date range) + GET /admin/payments/export.csv
- GET /admin/applications (filters), PATCH /admin/applications/:id {status, note}
- GET /admin/audit-logs
- POST /admin/payments/:id/reconcile (manual STK Query)
Health: GET /health

## 7. SECURITY & COMPLIANCE
- helmet, strict CORS (frontend origin only), rate limiting (login 5/min, OTP 3/hour, STK push 3 per 10 min per user), request size limits
- OTP: 6 digits, hashed at rest, 5-minute expiry, 5 attempts max
- Encrypt national ID at rest (AES-256-GCM, key from env); return only last 3 digits to clients and masked data in admin lists
- Never log passwords, OTPs, tokens, full IDs or full callback payloads at info level
- Kenya Data Protection Act 2019: consent record with timestamp and policy version, data-export and account-deletion endpoints (soft delete + anonymize), retention policy note
- Admin actions always audit-logged; admins cannot approve their own test accounts
- Refund/dispute support: admin can flag a payment as REFUND_REQUESTED with a note (manual refund process documented)
- Input sanitization on every endpoint, parameterized queries only (Prisma)

## 8. QUALITY
- Folder structure: src/{config,modules/{auth,payments,profile,loans,admin},middleware,lib/{mpesa,sms,crypto},jobs,utils}, prisma/, tests/
- Unit tests for phone normalization, password generation (STK), callback parsing; integration tests for the full flow (register → OTP → STK → callback → apply) with the Daraja and SMS clients mocked
- Provide a Postman/Thunder collection or the OpenAPI file
- README: setup, env variables, running with Docker, going live checklist (Daraja production go-live, HTTPS callback, backups, monitoring)

## 9. FRONTEND INTEGRATION
Provide a short guide for replacing the mock functions in the frontend (`frontend/index.html`) and admin panel (`admin/index.html`) with real calls (same routes as above, cookie-based auth, polling GET /payments/:id/status every 3 seconds for up to 90 seconds).

## 10. DELIVERY PLAN
Phase 1: project setup, Docker, Prisma schema + migrations, config, health check.
Phase 2: auth (register, OTP via Africa's Talking, login, refresh, password reset).
Phase 3: M-Pesa STK Push, callback, STK Query, reconciliation job, payment endpoints.
Phase 4: profile + loan application endpoints with eligibility guards.
Phase 5: admin auth, RBAC, stats, users, payments, applications, CSV export, audit logs.
Phase 6: tests, OpenAPI docs, README, deployment notes.
For each phase: give the file tree, the complete code for each file (no "rest of code here"), run instructions, and assumptions. Stop after each phase and wait for my go-ahead.

## 11. START
Begin with Phase 1 now.
