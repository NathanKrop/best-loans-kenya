import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "./db.js";
import { ConfigurationError, normalizeKenyanPhone } from "./lib/mpesa.js";

const scrypt = promisify(scryptCallback);
const ACCESS_COOKIE = "blk_access";
const accessLifetimeSeconds = 15 * 60;

export class SmsProviderError extends Error {}

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be configured with at least 32 characters.");
  }
  return secret;
}

function otpSecret(): string {
  const secret = process.env.OTP_HASH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("OTP_HASH_SECRET must be configured with at least 32 characters.");
  }
  return secret;
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createAccessToken(userId: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    sub: userId,
    iat: issuedAt,
    exp: issuedAt + accessLifetimeSeconds
  })}`;
  const signature = createHmac("sha256", jwtSecret()).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function verifyAccessToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", jwtSecret()).update(unsigned).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(parts[2], "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number" || payload.exp <= Date.now() / 1000) {
      return null;
    }
    return payload.sub;
  } catch {
    return null;
  }
}

function setAccessCookie(response: Response, userId: string): void {
  response.cookie(ACCESS_COOKIE, createAccessToken(userId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: accessLifetimeSeconds * 1000,
    path: "/"
  });
}

function requestCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

export async function requireUser(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    const userId = verifyAccessToken(bearer || requestCookie(request, ACCESS_COOKIE) || "");
    if (!userId) {
      response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true } });
    if (!user || user.status !== "ACTIVE") {
      response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });
      return;
    }
    request.userId = user.id;
    next();
  } catch (error) {
    next(error);
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64) as Buffer;
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(":");
  if (!saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hashOtp(code: string): string {
  return createHash("sha256").update(`${otpSecret()}:${code}`).digest("hex");
}

function createOtpCode(): string {
  const configuredCode = process.env.NODE_ENV !== "production" ? process.env.DEV_OTP_CODE : undefined;
  if (configuredCode) {
    if (!/^\d{6}$/.test(configuredCode)) {
      throw new ConfigurationError("DEV_OTP_CODE must be exactly six digits.");
    }
    return configuredCode;
  }
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

async function sendOtp(phone: string, code: string): Promise<void> {
  const username = process.env.AT_USERNAME;
  const apiKey = process.env.AT_API_KEY;
  if (!username || !apiKey) {
    if (process.env.NODE_ENV !== "production" && process.env.DEV_OTP_CODE) return;
    throw new ConfigurationError("SMS delivery is not configured. Set AT_USERNAME and AT_API_KEY.");
  }

  const form = new URLSearchParams({
    username,
    to: `+${phone}`,
    message: `Your Best Loans Kenya verification code is ${code}. It expires in 5 minutes.`
  });
  const response = await fetch("https://api.africastalking.com/version1/messaging", {
    method: "POST",
    headers: {
      apiKey,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    signal: AbortSignal.timeout(10_000),
    body: form
  });
  let result: {
    SMSMessageData?: { Recipients?: Array<{ status?: string }> };
  } = {};
  try {
    result = await response.json() as typeof result;
  } catch {
    throw new SmsProviderError("SMS provider returned an invalid response.");
  }
  if (!response.ok || !result.SMSMessageData?.Recipients?.some(recipient => recipient.status === "Success")) {
    throw new SmsProviderError("SMS provider could not deliver the verification code.");
  }
}

const registerSchema = z.object({
  fullName: z.string().trim().min(3).max(100),
  phone: z.string().min(9).max(16),
  password: z.string().min(10).max(128),
  consent: z.literal(true)
});

const verifySchema = z.object({
  phone: z.string().min(9).max(16),
  code: z.string().regex(/^\d{6}$/)
});

const loginSchema = z.object({
  phone: z.string().min(9).max(16),
  password: z.string().min(1).max(128)
});

export function createAuthRouter(express: typeof import("express")) {
  const router = express.Router();

  router.post("/register", async (request, response, next) => {
    try {
      const input = registerSchema.parse(request.body);
      const phone = normalizeKenyanPhone(input.phone);
      const passwordHash = await hashPassword(input.password);
      const user = await prisma.user.create({
        data: {
          fullName: input.fullName,
          phone,
          passwordHash,
          consentPolicyVersion: process.env.PRIVACY_POLICY_VERSION || "2026-10"
        },
        select: { id: true, phone: true }
      });

      const code = createOtpCode();
      try {
        await prisma.otpCode.create({
          data: { userId: user.id, codeHash: hashOtp(code), expiresAt: new Date(Date.now() + 5 * 60_000) }
        });
        await sendOtp(phone, code);
      } catch (error) {
        await prisma.user.delete({ where: { id: user.id } });
        throw error;
      }

      response.status(201).json({ data: { userId: user.id, phone: user.phone, message: "Verification code sent." } });
    } catch (error) {
      next(error);
    }
  });

  router.post("/resend-otp", async (request, response, next) => {
    try {
      const input = z.object({ phone: z.string().min(9).max(16) }).parse(request.body);
      const phone = normalizeKenyanPhone(input.phone);
      const user = await prisma.user.findUnique({ where: { phone } });
      if (!user || user.phoneVerifiedAt) {
        response.status(400).json({ error: { code: "OTP_UNAVAILABLE", message: "A new verification code cannot be sent." } });
        return;
      }

      const sentInLastHour = await prisma.otpCode.count({
        where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 60 * 60_000) } }
      });
      if (sentInLastHour >= 3) {
        response.status(429).json({ error: { code: "OTP_RATE_LIMIT", message: "You have reached the code request limit. Try again later." } });
        return;
      }

      const code = createOtpCode();
      await prisma.$transaction([
        prisma.otpCode.updateMany({
          where: { userId: user.id, consumedAt: null },
          data: { consumedAt: new Date() }
        }),
        prisma.otpCode.create({
          data: { userId: user.id, codeHash: hashOtp(code), expiresAt: new Date(Date.now() + 5 * 60_000) }
        })
      ]);
      await sendOtp(phone, code);
      response.json({ data: { message: "Verification code sent." } });
    } catch (error) {
      next(error);
    }
  });

  router.post("/verify-otp", async (request, response, next) => {
    try {
      const input = verifySchema.parse(request.body);
      const phone = normalizeKenyanPhone(input.phone);
      const user = await prisma.user.findUnique({ where: { phone } });
      if (!user) {
        response.status(400).json({ error: { code: "INVALID_CODE", message: "The code is invalid or expired." } });
        return;
      }

      const otp = await prisma.otpCode.findFirst({
        where: {
          userId: user.id,
          purpose: "VERIFY_PHONE",
          consumedAt: null,
          expiresAt: { gt: new Date() },
          attempts: { lt: 5 }
        },
        orderBy: { createdAt: "desc" }
      });
      if (!otp) {
        response.status(400).json({ error: { code: "INVALID_CODE", message: "The code is invalid or expired." } });
        return;
      }
      const isValid = timingSafeEqual(Buffer.from(otp.codeHash), Buffer.from(hashOtp(input.code)));
      if (!isValid) {
        await prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
        response.status(400).json({ error: { code: "INVALID_CODE", message: "The code is invalid or expired." } });
        return;
      }

      await prisma.$transaction([
        prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } }),
        prisma.user.update({ where: { id: user.id }, data: { phoneVerifiedAt: new Date() } })
      ]);
      setAccessCookie(response, user.id);
      response.json({
        data: {
          id: user.id,
          fullName: user.fullName,
          phone: user.phone,
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/login", async (request, response, next) => {
    try {
      const input = loginSchema.parse(request.body);
      const phone = normalizeKenyanPhone(input.phone);
      const user = await prisma.user.findUnique({ where: { phone } });
      if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
        response.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Phone number or password is incorrect." } });
        return;
      }
      if (!user.phoneVerifiedAt || user.status !== "ACTIVE") {
        response.status(403).json({ error: { code: "ACCOUNT_NOT_READY", message: "Verify your phone before signing in." } });
        return;
      }
      setAccessCookie(response, user.id);
      response.json({
        data: {
          id: user.id,
          fullName: user.fullName,
          phone: user.phone,
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", (_request, response) => {
    response.clearCookie(ACCESS_COOKIE, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
    response.status(204).end();
  });

  router.get("/me", requireUser, async (request: AuthenticatedRequest, response, next) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: request.userId },
        select: { id: true, fullName: true, phone: true }
      });
      if (!user) {
        response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Please sign in again." } });
        return;
      }
      response.json({
        data: {
          id: user.id,
          fullName: user.fullName,
          phone: user.phone,
        }
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
