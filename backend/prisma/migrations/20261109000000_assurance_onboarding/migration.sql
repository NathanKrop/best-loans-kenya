CREATE TYPE "AssuranceDocumentType" AS ENUM ('NATIONAL_ID', 'PASSPORT');
CREATE TYPE "AssuranceStatus" AS ENUM ('DRAFT', 'SUBMITTED');

ALTER TABLE "Profile"
  ALTER COLUMN "nationalIdEncrypted" DROP NOT NULL,
  ALTER COLUMN "nationalIdLast3" DROP NOT NULL;

CREATE TABLE "Assurance" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "documentType" "AssuranceDocumentType" NOT NULL,
  "nationalIdFront" TEXT,
  "nationalIdBack" TEXT,
  "passportBioPage" TEXT,
  "selfie" TEXT,
  "guarantorFullName" TEXT NOT NULL,
  "guarantorPhone" TEXT NOT NULL,
  "consentedAt" TIMESTAMP(3),
  "status" "AssuranceStatus" NOT NULL DEFAULT 'DRAFT',
  "submittedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Assurance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Assurance_userId_key" ON "Assurance"("userId");

ALTER TABLE "Assurance"
  ADD CONSTRAINT "Assurance_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Assurance" ENABLE ROW LEVEL SECURITY;
