ALTER TABLE "Payment" ADD COLUMN "loanApplicationId" UUID;

CREATE INDEX "Payment_loanApplicationId_purpose_status_idx"
  ON "Payment"("loanApplicationId", "purpose", "status");

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_loanApplicationId_fkey"
  FOREIGN KEY ("loanApplicationId") REFERENCES "LoanApplication"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
