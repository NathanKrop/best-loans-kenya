# Safaricom Payment and Loan Setup Record

Do not write Daraja API keys, passwords, or other secrets in this document or send them in chat; configure those privately in the backend environment.

## Collection destination

- Safaricom channel: Till (Buy Goods)
- Till number: 3584917
- If changing to PayBill, provide the PayBill number and account-reference format:

## Customer payment

- Upfront/application fee: 10% of the requested amount; charged by M-Pesa STK push when the applicant continues after submitting an application
- Refund policy: Full refund if the application is rejected or withdrawn; handled manually to the original M-Pesa number
- Approval disclosure: Paying the application fee does not guarantee approval or disbursement
- Interest: 10% flat total over the full loan term
- Interest handling: Include in the written offer and scheduled repayment, not as an upfront payment; it is separate from the application fee
- Repayment schedule: Single due date; loan term and exact due date are undecided

## Borrower payouts

- Send approved loan funds to the borrower's M-Pesa number? Yes
- Review: Manual admin assessment; no guaranteed approval
- Amounts for ages 18–25: Requests from KES 10,000 to KES 30,000
- Amounts over age 25: Requests from KES 30,000 to KES 200,000; admin assessment required
- Random loan amounts: Not supported; any offer must name an exact amount and disclose full terms
- Payout timing: 72-hour processing estimate only after final manual approval, borrower acceptance of a written offer and required checks; not a guarantee
- Owner-admin email: Configure privately in deployment settings when admin access is implemented

## Readiness

The application-fee STK flow is implemented but remains disabled unless `MPESA_ENV=production`, `MPESA_APPLICATION_FEE_ENABLED=true`, and live Daraja credentials and public HTTPS callback configuration are supplied privately to the backend. For the configured Till, use `MPESA_SHORTCODE=3584917` and `MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline`. Apply the database migration before enabling it. This repository does not provide production loan review, disbursement, automated refunds, customer-support contact details, or transaction reconciliation. Refunds must be processed manually to the original M-Pesa number for rejected or withdrawn applications. Do not enable collection until the refund operation, customer support and applicable legal/licensing review are ready. Production lending and payouts remain disabled.
