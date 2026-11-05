# Safaricom Payment and Loan Setup Record

Do not write Daraja API keys, passwords, or other secrets in this document or send them in chat; configure those privately in the backend environment.

## Collection destination

- Safaricom channel: Till (Buy Goods)
- Till number: 3584917
- If changing to PayBill, provide the PayBill number and account-reference format:

## Customer payment

- Upfront/application fee: None; do not collect before disbursement
- Interest: 10% flat total over the full loan term
- Interest handling: Include in the written offer and scheduled repayment, not as an upfront payment
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

The Till number is recorded, but live collection and payouts remain disabled. The loan term, full repayment dates, owner-admin decision interface and API, written-offer acceptance, and secure M-Pesa payout capability must be implemented and tested before lending. Production also requires the applicable legal/licensing review, live Daraja configuration and operational reconciliation.
