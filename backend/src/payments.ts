import type { AuthenticatedRequest } from "./auth.js";
import { requireUser } from "./auth.js";
import { prisma } from "./db.js";
import {
  ConfigurationError,
  MpesaClient,
  MpesaProviderError,
  normalizeKenyanPhone,
  readMpesaConfig
} from "./lib/mpesa.js";
import { z } from "zod";

const sandboxPaymentSchema = z.object({
  amount: z.number().int().min(1).max(1000),
  phone: z.string().min(9).max(16).optional()
});

const stkCallbackSchema = z.object({
  Body: z.object({
    stkCallback: z.object({
      CheckoutRequestID: z.string().min(1).max(128)
    })
  })
});

export function isMpesaSandboxTestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MPESA_ENV === "sandbox" && env.MPESA_SANDBOX_TEST_MODE === "true";
}

export function paymentStatusForMpesaResult(resultCode: number): "SUCCESS" | "FAILED" | "CANCELLED" | "TIMEOUT" {
  if (resultCode === 0) return "SUCCESS";
  if (resultCode === 1032) return "CANCELLED";
  if (resultCode === 1037) return "TIMEOUT";
  return "FAILED";
}

async function refreshSandboxPaymentStatus(
  paymentId: string,
  checkoutRequestId: string,
  callbackReceived = false
): Promise<void> {
  const result = await sandboxClient().queryStkPush(checkoutRequestId);
  if (result.CheckoutRequestID !== checkoutRequestId) {
    throw new MpesaProviderError("Safaricom returned a mismatched M-Pesa transaction.");
  }
  if (result.ResultCode === undefined || !/^\d+$/.test(result.ResultCode)) return;

  const resultCode = Number(result.ResultCode);
  if (!Number.isSafeInteger(resultCode) || resultCode > 2_147_483_647) {
    throw new MpesaProviderError("Safaricom returned an invalid transaction status.");
  }
  await prisma.payment.updateMany({
    where: { id: paymentId, status: "PENDING" },
    data: {
      status: paymentStatusForMpesaResult(resultCode),
      resultCode,
      resultDesc: result.ResultDesc || result.ResponseDescription,
      ...(callbackReceived ? { callbackReceivedAt: new Date() } : {})
    }
  });
}

function sandboxClient(): MpesaClient {
  if (!isMpesaSandboxTestEnabled()) {
    throw new ConfigurationError("M-Pesa sandbox test payments are disabled.");
  }
  const config = readMpesaConfig();
  if (config.environment !== "sandbox") {
    throw new ConfigurationError("Payment routes are restricted to the M-Pesa sandbox.");
  }
  return new MpesaClient(config);
}

function sandboxDisabled(response: import("express").Response): void {
  response.status(503).json({
    error: {
      code: "SANDBOX_PAYMENTS_DISABLED",
      message: "Sandbox test payments are disabled. Production payments are not available."
    }
  });
}

export function createPaymentsRouter(express: typeof import("express")) {
  const router = express.Router();

  router.post("/payments/sandbox/stk-push", requireUser, async (request: AuthenticatedRequest, response, next) => {
    if (!isMpesaSandboxTestEnabled()) {
      sandboxDisabled(response);
      return;
    }

    try {
      const input = sandboxPaymentSchema.parse(request.body);
      const client = sandboxClient();
      const user = await prisma.user.findUnique({
        where: { id: request.userId! },
        select: { phone: true }
      });
      const phone = normalizeKenyanPhone(input.phone || user?.phone || "");

      const recentPending = await prisma.payment.findFirst({
        where: {
          userId: request.userId!,
          purpose: "SANDBOX_TEST",
          status: "PENDING",
          createdAt: { gte: new Date(Date.now() - 5 * 60_000) }
        },
        select: { id: true }
      });
      if (recentPending) {
        response.status(409).json({
          error: {
            code: "SANDBOX_PAYMENT_PENDING",
            message: "A sandbox payment is already pending. Check its status before trying again."
          }
        });
        return;
      }

      const payment = await prisma.payment.create({
        data: {
          userId: request.userId!,
          purpose: "SANDBOX_TEST",
          amount: input.amount,
          phone
        },
        select: { id: true }
      });

      try {
        const result = await client.initiateStkPush({
          phone,
          amount: input.amount,
          accountReference: `DC${payment.id.replaceAll("-", "").slice(0, 10)}`,
          transactionDesc: "Sandbox test"
        });
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            merchantRequestId: result.MerchantRequestID,
            checkoutRequestId: result.CheckoutRequestID
          }
        });
        response.status(202).json({
          data: {
            id: payment.id,
            status: "PENDING",
            customerMessage: result.CustomerMessage
          }
        });
      } catch (error) {
        if (error instanceof MpesaProviderError) {
          await prisma.payment.update({
            where: { id: payment.id },
            data: { status: "FAILED", resultDesc: error.message }
          });
        }
        next(error);
      }
    } catch (error) {
      next(error);
    }
  });

  router.get("/payments/sandbox/me", requireUser, async (request: AuthenticatedRequest, response, next) => {
    if (!isMpesaSandboxTestEnabled()) {
      sandboxDisabled(response);
      return;
    }
    try {
      const payments = await prisma.payment.findMany({
        where: { userId: request.userId!, purpose: "SANDBOX_TEST" },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, amount: true, status: true, createdAt: true }
      });
      response.json({ data: payments });
    } catch (error) {
      next(error);
    }
  });

  router.get("/payments/sandbox/:paymentId/status", requireUser, async (request: AuthenticatedRequest, response, next) => {
    if (!isMpesaSandboxTestEnabled()) {
      sandboxDisabled(response);
      return;
    }
    try {
      const paymentId = z.string().uuid().parse(request.params.paymentId);
      let payment = await prisma.payment.findFirst({
        where: { id: paymentId, userId: request.userId!, purpose: "SANDBOX_TEST" },
        select: { id: true, amount: true, status: true, checkoutRequestId: true, createdAt: true }
      });
      if (!payment) {
        response.status(404).json({
          error: { code: "PAYMENT_NOT_FOUND", message: "The sandbox payment could not be found." }
        });
        return;
      }

      if (payment.status === "PENDING" && payment.checkoutRequestId) {
        await refreshSandboxPaymentStatus(payment.id, payment.checkoutRequestId);
        payment = await prisma.payment.findUnique({
          where: { id: payment.id },
          select: { id: true, amount: true, status: true, checkoutRequestId: true, createdAt: true }
        });
        if (!payment) {
          response.status(404).json({
            error: { code: "PAYMENT_NOT_FOUND", message: "The sandbox payment could not be found." }
          });
          return;
        }
      }
      response.json({
        data: {
          id: payment.id,
          amount: payment.amount,
          status: payment.status,
          createdAt: payment.createdAt
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/payments/mpesa/callback", async (request, response, next) => {
    if (!isMpesaSandboxTestEnabled()) {
      sandboxDisabled(response);
      return;
    }
    try {
      const input = stkCallbackSchema.parse(request.body);
      const checkoutRequestId = input.Body.stkCallback.CheckoutRequestID;
      const payment = await prisma.payment.findFirst({
        where: { checkoutRequestId, purpose: "SANDBOX_TEST" },
        select: { id: true }
      });
      if (!payment) {
        response.json({ ResultCode: 0, ResultDesc: "Accepted" });
        return;
      }

      await refreshSandboxPaymentStatus(payment.id, checkoutRequestId, true);
      response.json({ ResultCode: 0, ResultDesc: "Accepted" });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
