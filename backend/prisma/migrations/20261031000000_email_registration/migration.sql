ALTER TABLE "User"
  ADD COLUMN "email" TEXT,
  ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
  ALTER COLUMN "phone" DROP NOT NULL;

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE TYPE "OtpPurpose_new" AS ENUM ('VERIFY_PHONE', 'VERIFY_EMAIL');
ALTER TABLE "OtpCode" ALTER COLUMN "purpose" DROP DEFAULT;
ALTER TABLE "OtpCode"
  ALTER COLUMN "purpose" TYPE "OtpPurpose_new"
  USING ("purpose"::text::"OtpPurpose_new");
DROP TYPE "OtpPurpose";
ALTER TYPE "OtpPurpose_new" RENAME TO "OtpPurpose";
ALTER TABLE "OtpCode" ALTER COLUMN "purpose" SET DEFAULT 'VERIFY_EMAIL';
