export interface LoanOfferTerms {
  approvedAmount: number;
  interestBasisPoints: 1000;
  interestAmount: number;
  repaymentAmount: number;
  termDays: number;
}

export type LoanOfferStatus =
  | "OFFERED"
  | "DECLINED"
  | "DISBURSEMENT_PENDING"
  | "DISBURSEMENT_FAILED"
  | "ACTIVE"
  | "REPAID";

export function isLoanSandboxEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.MPESA_ENV === "sandbox" &&
    env.MPESA_SANDBOX_TEST_MODE === "true" &&
    env.LOAN_WORKFLOW_SANDBOX_MODE === "true";
}

export function isConfirmedDisbursementResult(
  resultCode: number,
  receipt: unknown,
  transactionAmount: unknown,
  expectedAmount: number
): boolean {
  return resultCode === 0 &&
    typeof receipt === "string" &&
    receipt.trim().length > 0 &&
    Number.isSafeInteger(expectedAmount) &&
    Number(transactionAmount) === expectedAmount;
}

export function canTransitionLoanOffer(from: LoanOfferStatus, to: LoanOfferStatus): boolean {
  const transitions: Record<LoanOfferStatus, LoanOfferStatus[]> = {
    OFFERED: ["DECLINED", "DISBURSEMENT_PENDING"],
    DECLINED: [],
    DISBURSEMENT_PENDING: ["DISBURSEMENT_FAILED", "ACTIVE"],
    DISBURSEMENT_FAILED: ["DISBURSEMENT_PENDING"],
    ACTIVE: ["REPAID"],
    REPAID: []
  };
  return transitions[from].includes(to);
}

export function createLoanOfferTerms(
  requestedAmount: number,
  approvedAmount: number,
  termDays: number
): LoanOfferTerms {
  if (!Number.isSafeInteger(requestedAmount) || !Number.isSafeInteger(approvedAmount)) {
    throw new RangeError("Loan amounts must be whole numbers.");
  }
  if (approvedAmount < 1 || approvedAmount > requestedAmount) {
    throw new RangeError("The approved amount must be positive and no greater than the requested amount.");
  }
  if (!Number.isInteger(termDays) || termDays < 7 || termDays > 90) {
    throw new RangeError("The repayment term must be between 7 and 90 days.");
  }
  const interestAmount = Math.round(approvedAmount * 0.1);
  return {
    approvedAmount,
    interestBasisPoints: 1000,
    interestAmount,
    repaymentAmount: approvedAmount + interestAmount,
    termDays
  };
}

export function canAcceptLoanOffer(status: LoanOfferStatus): boolean {
  return status === "OFFERED" || status === "DISBURSEMENT_FAILED";
}

export function canStartRepayment(status: LoanOfferStatus): boolean {
  return status === "ACTIVE";
}

export function dueDateFromDisbursement(disbursedAt: Date, termDays: number): Date {
  if (!Number.isInteger(termDays) || termDays < 1 || !Number.isFinite(disbursedAt.getTime())) {
    throw new RangeError("A valid disbursement date and repayment term are required.");
  }
  return new Date(disbursedAt.getTime() + termDays * 86_400_000);
}
