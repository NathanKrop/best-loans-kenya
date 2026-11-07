import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canAcceptLoanOffer,
  canStartRepayment,
  canTransitionLoanOffer,
  createLoanOfferTerms,
  dueDateFromDisbursement,
  isConfirmedDisbursementResult,
  isLoanSandboxEnabled
} from "../src/loan-workflow-domain.js";

test("creates clear flat-10-percent repayment terms", () => {
  assert.deepEqual(createLoanOfferTerms(20_000, 15_000, 30), {
    approvedAmount: 15_000,
    interestBasisPoints: 1000,
    interestAmount: 1_500,
    repaymentAmount: 16_500,
    termDays: 30
  });
});

test("rejects an approved amount above the request and invalid terms", () => {
  assert.throws(() => createLoanOfferTerms(10_000, 10_001, 30), /no greater than the requested/);
  assert.throws(() => createLoanOfferTerms(10_000, 10_000, 6), /between 7 and 90/);
});

test("only offered loans can be accepted and only disbursed loans can be repaid", () => {
  assert.equal(canAcceptLoanOffer("OFFERED"), true);
  assert.equal(canAcceptLoanOffer("DISBURSEMENT_FAILED"), true);
  assert.equal(canAcceptLoanOffer("ACTIVE"), false);
  assert.equal(canStartRepayment("ACTIVE"), true);
  assert.equal(canStartRepayment("DISBURSEMENT_PENDING"), false);
});

test("loan lifecycle permits only the expected state transitions", () => {
  assert.equal(canTransitionLoanOffer("OFFERED", "DISBURSEMENT_PENDING"), true);
  assert.equal(canTransitionLoanOffer("DISBURSEMENT_PENDING", "ACTIVE"), true);
  assert.equal(canTransitionLoanOffer("ACTIVE", "REPAID"), true);
  assert.equal(canTransitionLoanOffer("OFFERED", "ACTIVE"), false);
  assert.equal(canTransitionLoanOffer("DISBURSEMENT_FAILED", "ACTIVE"), false);
  assert.equal(canTransitionLoanOffer("DISBURSEMENT_FAILED", "DISBURSEMENT_PENDING"), true);
});

test("only successful disbursement callbacks with matching amounts are confirmed", () => {
  assert.equal(isConfirmedDisbursementResult(0, "MPESA123", 15_000, 15_000), true);
  assert.equal(isConfirmedDisbursementResult(0, "MPESA123", 14_999, 15_000), false);
  assert.equal(isConfirmedDisbursementResult(1, "MPESA123", 15_000, 15_000), false);
  assert.equal(isConfirmedDisbursementResult(0, undefined, 15_000, 15_000), false);
});

test("loan lifecycle is enabled only with explicit sandbox flags", () => {
  assert.equal(isLoanSandboxEnabled({
    MPESA_ENV: "sandbox",
    MPESA_SANDBOX_TEST_MODE: "true",
    LOAN_WORKFLOW_SANDBOX_MODE: "true"
  }), true);
  assert.equal(isLoanSandboxEnabled({
    MPESA_ENV: "production",
    MPESA_SANDBOX_TEST_MODE: "true",
    LOAN_WORKFLOW_SANDBOX_MODE: "true"
  }), false);
  assert.equal(isLoanSandboxEnabled({
    MPESA_ENV: "sandbox",
    MPESA_SANDBOX_TEST_MODE: "true",
    LOAN_WORKFLOW_SANDBOX_MODE: "false"
  }), false);
});

test("repayment due date is counted from confirmed disbursement", () => {
  assert.equal(
    dueDateFromDisbursement(new Date("2026-11-07T10:00:00.000Z"), 30).toISOString(),
    "2026-12-07T10:00:00.000Z"
  );
});
