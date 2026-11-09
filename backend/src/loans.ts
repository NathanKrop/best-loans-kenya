import { createCipheriv, randomBytes } from "node:crypto";
import type { AuthenticatedRequest } from "./auth.js";
import { requireUser } from "./auth.js";
import { prisma } from "./db.js";
import { ConfigurationError } from "./lib/mpesa.js";
import { z } from "zod";

const counties = [
  "Baringo", "Bomet", "Bungoma", "Busia", "Elgeyo-Marakwet", "Embu", "Garissa", "Homa Bay",
  "Isiolo", "Kajiado", "Kakamega", "Kericho", "Kiambu", "Kilifi", "Kirinyaga", "Kisii",
  "Kisumu", "Kitui", "Kwale", "Laikipia", "Lamu", "Machakos", "Makueni", "Mandera",
  "Marsabit", "Meru", "Migori", "Mombasa", "Murang'a", "Nairobi", "Nakuru", "Nandi",
  "Narok", "Nyamira", "Nyandarua", "Nyeri", "Samburu", "Siaya", "Taita-Taveta",
  "Tana River", "Tharaka-Nithi", "Trans Nzoia", "Turkana", "Uasin Gishu", "Vihiga",
  "Wajir", "West Pokot", "Other"
] as const;

const incomeRanges = [
  "Below KES 15,000",
  "KES 15,000 to 40,000",
  "KES 40,000 to 100,000",
  "Above KES 100,000"
] as const;

const profileSchema = z.object({
  nationalId: z.string().regex(/^\d{7,8}$/).optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }),
  county: z.enum(counties),
  monthlyIncomeRange: z.enum(incomeRanges)
});

export function ageOn(dateOfBirth: Date, now = new Date()): number {
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < dateOfBirth.getUTCMonth() ||
    (now.getUTCMonth() === dateOfBirth.getUTCMonth() && now.getUTCDate() < dateOfBirth.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export function isAtLeastEighteen(dateOfBirth: Date, now = new Date()): boolean {
  return ageOn(dateOfBirth, now) >= 18;
}

export function requestedAmountRangeForAge(age: number): { min: number; max: number } | null {
  if (!Number.isInteger(age) || age < 18) return null;
  return age <= 25 ? { min: 10000, max: 30000 } : { min: 30000, max: 200000 };
}

const applicationSchema = z.object({
  amount: z.number().int().min(1000).max(200000),
  periodDays: z.number().int().min(7).max(90),
  purpose: z.string().trim().min(2).max(80)
});

function encryptNationalId(nationalId: string): string {
  const keyHex = process.env.NATIONAL_ID_ENCRYPTION_KEY;
  if (!keyHex || !/^[a-fA-F0-9]{64}$/.test(keyHex)) {
    throw new ConfigurationError("NATIONAL_ID_ENCRYPTION_KEY must be configured as 64 hexadecimal characters.");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(nationalId, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function createLoansRouter(express: typeof import("express")) {
  const router = express.Router();

  router.get("/profile/me", requireUser, async (request: AuthenticatedRequest, response, next) => {
    try {
      const profile = await prisma.profile.findUnique({ where: { userId: request.userId } });
      response.json({
        data: profile ? {
          nationalIdLast3: profile.nationalIdLast3,
          dateOfBirth: profile.dateOfBirth.toISOString().slice(0, 10),
          county: profile.county,
          monthlyIncomeRange: profile.monthlyIncomeRange
        } : null
      });
    } catch (error) {
      next(error);
    }
  });

  router.put("/profile/me", requireUser, async (request: AuthenticatedRequest, response, next) => {
    try {
      const input = profileSchema.parse(request.body);
      const dateOfBirth = new Date(`${input.dateOfBirth}T00:00:00.000Z`);
      if (!isAtLeastEighteen(dateOfBirth)) {
        response.status(403).json({
          error: { code: "AGE_REQUIREMENT_NOT_MET", message: "You must be at least 18 years old to apply." }
        });
        return;
      }
      const encrypted = input.nationalId ? encryptNationalId(input.nationalId) : undefined;
      const profile = await prisma.profile.upsert({
        where: { userId: request.userId! },
        create: {
          userId: request.userId!,
          ...(input.nationalId ? {
            nationalIdEncrypted: encrypted,
            nationalIdLast3: input.nationalId.slice(-3)
          } : {}),
          dateOfBirth,
          county: input.county,
          monthlyIncomeRange: input.monthlyIncomeRange
        },
        update: {
          ...(input.nationalId ? {
            nationalIdEncrypted: encrypted,
            nationalIdLast3: input.nationalId.slice(-3)
          } : {}),
          dateOfBirth,
          county: input.county,
          monthlyIncomeRange: input.monthlyIncomeRange
        },
        select: { nationalIdLast3: true, county: true, monthlyIncomeRange: true }
      });
      response.json({ data: profile });
    } catch (error) {
      next(error);
    }
  });

  router.get("/loans/me", requireUser, async (request: AuthenticatedRequest, response, next) => {
    try {
      const applications = await prisma.loanApplication.findMany({
        where: { userId: request.userId },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: { id: true, amount: true, periodDays: true, purpose: true, status: true, createdAt: true }
      });
      response.json({ data: applications });
    } catch (error) {
      next(error);
    }
  });

  router.post("/loans/apply", requireUser, async (request: AuthenticatedRequest, response, next) => {
    try {
      const input = applicationSchema.parse(request.body);
      const user = await prisma.user.findUnique({
        where: { id: request.userId! },
        select: {
          profile: { select: { dateOfBirth: true } },
          assurance: { select: { status: true } }
        }
      });
      if (user?.assurance?.status !== "SUBMITTED") {
        response.status(403).json({
          error: { code: "ASSURANCE_REQUIRED", message: "Complete the assurance step before applying." }
        });
        return;
      }
      if (!user?.profile) {
        response.status(403).json({
          error: {
            code: "APPLICATION_NOT_READY",
            message: "Complete your profile before applying."
          }
        });
        return;
      }
      const age = ageOn(user.profile.dateOfBirth);
      const amountRange = requestedAmountRangeForAge(age);
      if (!amountRange) {
        response.status(403).json({
          error: { code: "AGE_REQUIREMENT_NOT_MET", message: "You must be at least 18 years old to apply." }
        });
        return;
      }
      if (input.amount < amountRange.min || input.amount > amountRange.max) {
        response.status(422).json({
          error: {
            code: "AMOUNT_OUT_OF_RANGE",
            message: age <= 25
              ? "Applicants aged 18 to 25 may request between KES 10,000 and KES 30,000."
              : "Applicants over 25 may request between KES 30,000 and KES 200,000."
          }
        });
        return;
      }
      const application = await prisma.loanApplication.create({
        data: { userId: request.userId!, ...input },
        select: { id: true, amount: true, periodDays: true, purpose: true, status: true, createdAt: true }
      });
      response.status(201).json({ data: application });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
