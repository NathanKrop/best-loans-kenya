import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireUser, type AuthenticatedRequest } from "./auth.js";
import { prisma } from "./db.js";
import {
  ConfigurationError,
  InputError,
  MpesaClient,
  MpesaProviderError,
  normalizeKenyanPhone,
  readMpesaConfig
} from "./lib/mpesa.js";

type MpesaCallback = {
  Body?: {
    stkCallback?: {
      CheckoutRequestID?: string;
      ResultCode?: number | string;
      ResultDesc?: string;
      CallbackMetadata?: {
        Item?: Array<{ Name?: string; Value?: string | number }>;
      };
    };
  };
};

const requestSchema = z.object({ phone: z.string().min(9).max(16).optional() });

let client: MpesaClient | undefined;

function mpesaClient(): MpesaClient {
  client ||= new MpesaClient(readMpesaConfig());
  return client;
}

function registrationFee(): number {
  const fee = Number(process.env.REGISTRATION_FEE || 250);
  if (!Number.isSafeInteger(fee) || fee < 1) {
    throw new ConfigurationError("REGISTRATION_FEE must be a positive whole number.");
  }
  return fee;
}

function callbackValue(items: Array<{ Name?: string; Value?: string | number }> | undefined, name: string) {
  return items?.find(item => item.Name === name)?.Value;
}

export function friendlyFailure(resultCode: number): string {
  const messages: Record<number, string> = {
    1032: "The payment was cancelled on your phone.",
    1037: "The payment request timed out. Please try again.",
    2001: "The M-Pesa PIN was not accepted. Check the prompt and try again.",
    1: "There were not enough funds to complete the payment."
  };
  return messages[resultCode] || "The payment was not completed.";
}

export function parseTransactionDate(value: string | number | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const digits = String(value);
  if (!/^\d{14}$/.test(digits)) return undefined;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const hour = Number(digits.slice(8, 10));
  const minute = Number(digits.slice(10, 12));
  const second = Number(digits.slice(12, 14));
  const localDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    localDate.getUTCFullYear() !== year ||
    localDate.getUTCMonth() !== month - 1 ||
    localDate.getUTCDate() !== day ||
    localDate.getUTCHours() !== hour ||
    localDate.getUTCMinutes() !== minute ||
    localDate.getUTCSeconds() !== second
  ) return undefined;
  return new Date(localDate.getTime() - 3 * 60 * 60 * 1000);
}

export function createPaymentsRouter(express: typeof import("express")) {
  const router = express.Router();

  router.post("/registration/stk-push", requireUser, async (request: AuthenticatedRequest, response, next) => {
    try {
      const { phone: requestedPhone } = requestSchema.parse(request.body);
      const user = await prisma.user.findUnique({ where: { id: request.userId! } });
      if (!user || !user.phoneVerifiedAt) {
        response.status(403).json({ error: { code: "PHONE_NOT_VERIFIED", message: "Verify your phone before making a payment." } });
        return;
      }
      if (user.registrationPaidAt) {
        response.status(409).json({ error: { code: "ALREADY_PAID", message: "The registration fee has already been paid." } });
        return;
      }

      const phone = normalizeKenyanPhone(requestedPhone || user.phone);
      const fee = registrationFee();
      const client = mpesaClient();
      const activePayment = await prisma.payment.findUnique({
        where: { pendingKey: user.id },
        select: { id: true, checkoutRequestId: true, status: true }
      });
      if (activePayment) {
        response.status(202).json({
          data: {
            paymentId: activePayment.id,
            checkoutRequestId: activePayment.checkoutRequestId,
            status: activePayment.status
          }
        });
        return;
      }

      let reservation: Prisma.PaymentGetPayload<{
        select: { id: true; checkoutRequestId: true; status: true }
      }>;
      try {
        reservation = await prisma.payment.create({
          data: { userId: user.id, amount: fee, phone, pendingKey: user.id },
          select: { id: true, checkoutRequestId: true, status: true }
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
        const duplicate = await prisma.payment.findUnique({
          where: { pendingKey: user.id },
          select: { id: true, checkoutRequestId: true, status: true }
        });
        if (!duplicate) throw error;
        response.status(202).json({
          data: { paymentId: duplicate.id, checkoutRequestId: duplicate.checkoutRequestId, status: duplicate.status }
        });
        return;
      }

      try {
        const initiated = await client.initiateStkPush({
          phone,
          amount: fee,
          accountReference: `BLK${user.id.replace(/-/g, "").slice(-8)}`,
          transactionDesc: "Registration"
        });
        const payment = await prisma.payment.update({
          where: { id: reservation.id },
          data: {
            merchantRequestId: initiated.MerchantRequestID,
            checkoutRequestId: initiated.CheckoutRequestID
          },
          select: { id: true, checkoutRequestId: true, status: true }
        });
        response.status(202).json({ data: { paymentId: payment.id, checkoutRequestId: payment.checkoutRequestId, status: payment.status } });
      } catch (error) {
        if (error instanceof MpesaProviderError) {
          await prisma.payment.update({
            where: { id: reservation.id },
            data: { status: "FAILED", pendingKey: null, resultDesc: error.message }
          });
          response.status(502).json({ error: { code: "PAYMENT_PROVIDER_ERROR", message: error.message } });
          return;
        }
        if (error instanceof InputError || error instanceof ConfigurationError) throw error;
        console.error("M-Pesa request outcome could not be confirmed.");
        response.status(502).json({
          error: {
            code: "PAYMENT_STATUS_UNKNOWN",
            message: "We could not confirm the payment request. Do not retry yet; contact support to check its status."
          }
        });
      }
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id/status", requireUser, async (request: AuthenticatedRequest, response, next) => {
    try {
      const paymentId = request.params.id;
      if (typeof paymentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(paymentId)) {
        response.status(400).json({ error: { code: "INVALID_INPUT", message: "Invalid payment ID." } });
        return;
      }
      const payment = await prisma.payment.findFirst({
        where: { id: paymentId, userId: request.userId },
        select: {
          id: true,
          amount: true,
          phone: true,
          status: true,
          resultDesc: true,
          mpesaReceiptNumber: true,
          createdAt: true
        }
      });
      if (!payment) {
        response.status(404).json({ error: { code: "PAYMENT_NOT_FOUND", message: "Payment was not found." } });
        return;
      }
      response.json({ data: payment });
    } catch (error) {
      next(error);
    }
  });

  router.get("/me", requireUser, async (request: AuthenticatedRequest, response, next) => {
    try {
      const payments = await prisma.payment.findMany({
        where: { userId: request.userId },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          amount: true,
          phone: true,
          status: true,
          resultDesc: true,
          mpesaReceiptNumber: true,
          createdAt: true
        }
      });
      response.json({ data: payments });
    } catch (error) {
      next(error);
    }
  });

  router.post("/mpesa/callback", (request: Request, response: Response) => {
    response.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    setImmediate(() => {
      void processMpesaCallback(request.body as MpesaCallback).catch(() => {
        console.error("M-Pesa callback reconciliation failed.");
      });
    });
  });

  return router;
}

async function processMpesaCallback(payload: MpesaCallback): Promise<void> {
  const callback = payload?.Body?.stkCallback;
  const checkoutRequestId = callback?.CheckoutRequestID;
  if (!checkoutRequestId) return;

  const payment = await prisma.payment.findUnique({ where: { checkoutRequestId } });
  if (!payment) return;

  const resultCode = Number(callback?.ResultCode);
  if (!Number.isInteger(resultCode)) return;
  if (payment.status === "PENDING" && resultCode !== 0) {
    const status = resultCode === 1032 ? "CANCELLED" : resultCode === 1037 ? "TIMEOUT" : "FAILED";
    await prisma.payment.updateMany({
      where: { id: payment.id, status: "PENDING" },
      data: {
        status,
        pendingKey: null,
        resultCode,
        resultDesc: friendlyFailure(resultCode),
        callbackReceivedAt: new Date()
      }
    });
    return;
  }
  if (resultCode !== 0 || (payment.status !== "PENDING" && payment.status !== "SUCCESS")) return;

  const items = callback?.CallbackMetadata?.Item;
  const amount = callbackValue(items, "Amount");
  const receipt = callbackValue(items, "MpesaReceiptNumber");
  const callbackPhone = callbackValue(items, "PhoneNumber");
  const transactionDate = parseTransactionDate(callbackValue(items, "TransactionDate"));
  if (Number(amount) !== payment.amount || typeof receipt !== "string" || !receipt.trim() || callbackPhone === undefined) return;
  if (normalizeKenyanPhone(String(callbackPhone)) !== payment.phone) return;

  const query = await mpesaClient().queryStkPush(checkoutRequestId);
  if (
    query.ResponseCode !== "0" ||
    query.CheckoutRequestID !== checkoutRequestId ||
    Number(query.ResultCode) !== 0
  ) return;

  await prisma.$transaction(async (transaction: Prisma.TransactionClient) => {
    const current = await transaction.payment.findUnique({ where: { id: payment.id } });
    if (
      !current ||
      (current.status !== "PENDING" && !(current.status === "SUCCESS" && !current.mpesaReceiptNumber))
    ) return;
    await transaction.payment.update({
      where: { id: payment.id },
      data: {
        status: "SUCCESS",
        pendingKey: null,
        mpesaReceiptNumber: receipt,
        transactionDate,
        resultCode: 0,
        resultDesc: String(callback?.ResultDesc || "Payment received.").slice(0, 250),
        callbackReceivedAt: new Date()
      }
    });
    await transaction.user.update({
      where: { id: payment.userId },
      data: { registrationPaidAt: new Date() }
    });
  });
}
