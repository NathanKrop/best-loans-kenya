ALTER TYPE "LoanApplicationStatus" ADD VALUE 'OFFERED';

CREATE TYPE "LoanOfferStatus" AS ENUM (
  'OFFERED',
  'DECLINED',
  'DISBURSEMENT_PENDING',
  'DISBURSEMENT_FAILED',
  'ACTIVE',
  'REPAID'
);

CREATE TABLE "LoanOffer" (
  "id" UUID NOT NULL,
  "applicationId" UUID NOT NULL,
  "approvedAmount" INTEGER NOT NULL,
  "interestBasisPoints" INTEGER NOT NULL DEFAULT 1000,
  "interestAmount" INTEGER NOT NULL,
  "repaymentAmount" INTEGER NOT NULL,
  "termDays" INTEGER NOT NULL,
  "status" "LoanOfferStatus" NOT NULL DEFAULT 'OFFERED',
  "note" TEXT NOT NULL,
  "offeredByUserId" UUID NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "disbursedAt" TIMESTAMP(3),
  "dueAt" TIMESTAMP(3),
  "repaidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LoanOffer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LoanAuditLog" (
  "id" UUID NOT NULL,
  "applicationId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "action" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoanAuditLog_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Payment" ADD COLUMN "loanOfferId" UUID;

CREATE UNIQUE INDEX "LoanOffer_applicationId_key" ON "LoanOffer"("applicationId");
CREATE INDEX "LoanAuditLog_applicationId_createdAt_idx" ON "LoanAuditLog"("applicationId", "createdAt");
CREATE INDEX "Payment_loanOfferId_purpose_status_idx" ON "Payment"("loanOfferId", "purpose", "status");

ALTER TABLE "LoanOffer"
  ADD CONSTRAINT "LoanOffer_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "LoanApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "LoanOffer_offeredByUserId_fkey"
  FOREIGN KEY ("offeredByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LoanAuditLog"
  ADD CONSTRAINT "LoanAuditLog_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "LoanApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "LoanAuditLog_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_loanOfferId_fkey"
  FOREIGN KEY ("loanOfferId") REFERENCES "LoanOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
