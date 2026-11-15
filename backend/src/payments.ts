import type { AuthenticatedRequest } from "./auth.js";
import { requireUser } from "./auth.js";
import { prisma } from "./db.js";
import {
  ConfigurationError,
  MpesaClient,
  MpesaProviderError,
  normalizeKenyanPhone,
  readMpesaConfig,
  validMpesaCallbackToken
} from "./lib/mpesa.js";
import { z } from "zod";

const sandboxPaymentSchema = z.object({
  amount: z.number().int().min(1).max(1000),
  phone: z.string().min(9).max(16).optional()
});

const applicationFeeSchema = z.object({
  applicationId: z.string().uuid(),
  phone: z.string().min(9).max(16),
  acceptTerms: z.literal(true)
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

export function isProductionApplicationFeeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MPESA_ENV === "production" && env.MPESA_APPLICATION_FEE_ENABLED === "true";
}

export function applicationFeeForAmount(amount: number): number {
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new RangeError("The requested loan amount must be a positive whole number.");
  }
  return Math.round(amount * 0.1);
}

export function paymentStatusForMpesaResult(resultCode: number): "SUCCESS" | "FAILED" | "CANCELLED" | "TIMEOUT" {
  if (resultCode === 0) return "SUCCESS";
  if (resultCode === 1032) return "CANCELLED";
  if (resultCode === 1037) return "TIMEOUT";
  return "FAILED";
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "P2002";
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
  await prisma.$transaction(async transaction => {
    const updated = await transaction.payment.updateMany({
      where: { id: paymentId, status: "PENDING" },
      data: {
        status: paymentStatusForMpesaResult(resultCode),
        resultCode,
        resultDesc: result.ResultDesc || result.ResponseDescription,
        pendingKey: null,
        ...(callbackReceived ? { callbackReceivedAt: new Date() } : {})
      }
    });
    if (updated.count !== 1 || resultCode !== 0) return;
    const payment = await transaction.payment.findUnique({
      where: { id: paymentId },
      select: { loanOfferId: true, purpose: true, userId: true }
    });
    if (payment?.loanOfferId && payment.purpose === "SANDBOX_REPAYMENT") {
      const offer = await transaction.loanOffer.findUnique({
        where: { id: payment.loanOfferId },
        select: { applicationId: true }
      });
      const repaid = await transaction.loanOffer.updateMany({
        where: { id: payment.loanOfferId, status: "ACTIVE" },
        data: { status: "REPAID", repaidAt: new Date() }
      });
      if (repaid.count === 1 && offer) {
        await transaction.loanAuditLog.create({
          data: {
            applicationId: offer.applicationId,
            actorUserId: payment.userId,
            action: "REPAYMENT_CONFIRMED",
            note: "Sandbox repayment was confirmed by the M-Pesa status query."
          }
        });
      }
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

function productionClient(): MpesaClient {
  if (!isProductionApplicationFeeEnabled()) {
    throw new ConfigurationError("Production application-fee collection is disabled.");
  }
  const config = readMpesaConfig();
  if (config.environment !== "production") {
    throw new ConfigurationError("Application-fee payments require production M-Pesa configuration.");
  }
  const callbackToken = new URL(config.callbackUrl).searchParams.get("token") || undefined;
  if (!validMpesaCallbackToken(callbackToken)) {
    throw new ConfigurationError("MPESA_CALLBACK_URL must include the configured callback token.");
  }
  return new MpesaClient(config);
}

async function refreshProductionApplicationFeeStatus(
  paymentId: string,
  checkoutRequestId: string,
  callbackReceived = false
): Promise<void> {
  const result = await productionClient().queryStkPush(checkoutRequestId);
  if (result.CheckoutRequestID !== checkoutRequestId) {
    throw new MpesaProviderError("Safaricom returned a mismatched M-Pesa transaction.");
  }
  if (result.ResultCode === undefined || !/^\d+$/.test(result.ResultCode)) return;

  const resultCode = Number(result.ResultCode);
  if (!Number.isSafeInteger(resultCode) || resultCode > 2_147_483_647) {
    throw new MpesaProviderError("Safaricom returned an invalid transaction status.");
  }
  await prisma.payment.updateMany({
    where: { id: paymentId, purpose: "APPLICATION_FEE", status: "PENDING" },
    data: {
      status: paymentStatusForMpesaResult(resultCode),
      resultCode,
      resultDesc: result.ResultDesc || result.ResponseDescription,
      pendingKey: null,
      ...(callbackReceived ? { callbackReceivedAt: new Date() } : {})
    }
  });
}

function sandboxDisabled(response: import("express").Response): void {
  response.status(503).json({
    error: {
      code: "SANDBOX_PAYMENTS_DISABLED",
      message: "Sandbox test payments are disabled."
    }
  });
}

export function createPaymentsRouter(express: typeof import("express")) {
  const router = express.Router();

  router.get("/payments/production/application-fee/config", (_request, response) => {
    const enabled = isProductionApplicationFeeEnabled();
    if (enabled) productionClient();
    response.json({ data: { enabled } });
  });

  router.post("/payments/production/application-fee", requireUser, async (request: AuthenticatedRequest, response, next) => {
    if (!isProductionApplicationFeeEnabled()) {
      response.status(503).json({
        error: {
          code: "APPLICATION_FEE_COLLECTION_DISABLED",
          message: "Production application-fee collection is not enabled."
        }
      });
      return;
    }

    try {
      const input = applicationFeeSchema.parse(request.body);
      const client = productionClient();
      const phone = normalizeKenyanPhone(input.phone);
      const application = await prisma.loanApplication.findFirst({
        where: { id: input.applicationId, userId: request.userId! },
        select: { id: true, amount: true, status: true }
      });
      if (!application) {
        response.status(404).json({
          error: { code: "APPLICATION_NOT_FOUND", message: "The loan application could not be found." }
        });
        return;
      }
      if (application.status !== "PENDING") {
        response.status(409).json({
          error: { code: "APPLICATION_NOT_PENDING", message: "An application fee cannot be requested for this application." }
        });
        return;
      }

      const existingPayment = await prisma.payment.findFirst({
        where: {
          loanApplicationId: application.id,
          purpose: "APPLICATION_FEE",
          status: { in: ["PENDING", "SUCCESS"] }
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, amount: true, status: true, checkoutRequestId: true }
      });
      if (existingPayment?.status === "SUCCESS") {
        response.json({
          data: { paymentId: existingPayment.id, amount: existingPayment.amount, status: existingPayment.status }
        });
        return;
      }
      if (existingPayment?.status === "PENDING") {
        response.status(202).json({
          data: { paymentId: existingPayment.id, amount: existingPayment.amount, status: existingPayment.status }
        });
        return;
      }

      const amount = applicationFeeForAmount(application.amount);
      const pendingKey = `${application.id}:APPLICATION_FEE`;
      let payment: { id: string };
      try {
        payment = await prisma.payment.create({
          data: {
            userId: request.userId!,
            loanApplicationId: application.id,
            pendingKey,
            purpose: "APPLICATION_FEE",
            amount,
            phone
          },
          select: { id: true }
        });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const concurrentPayment = await prisma.payment.findFirst({
          where: { pendingKey, status: "PENDING" },
          select: { id: true, amount: true }
        });
        if (!concurrentPayment) throw error;
        response.status(202).json({
          data: { paymentId: concurrentPayment.id, amount: concurrentPayment.amount, status: "PENDING" }
        });
        return;
      }

      try {
        const result = await client.initiateStkPush({
          phone,
          amount,
          accountReference: `DC${payment.id.replaceAll("-", "").slice(0, 10)}`,
          transactionDesc: "App fee"
        });
        await prisma.payment.update({
          where: { id: payment.id },
          data: { merchantRequestId: result.MerchantRequestID, checkoutRequestId: result.CheckoutRequestID }
        });
        response.status(202).json({
          data: { paymentId: payment.id, amount, status: "PENDING", customerMessage: result.CustomerMessage }
        });
      } catch (error) {
        if (error instanceof MpesaProviderError) {
          await prisma.payment.update({
            where: { id: payment.id },
            data: { status: "FAILED", resultDesc: error.message, pendingKey: null }
          });
        }
        next(error);
      }
    } catch (error) {
      next(error);
    }
  });

  router.get("/payments/production/application-fee/:paymentId/status", requireUser, async (request: AuthenticatedRequest, response, next) => {
    if (!isProductionApplicationFeeEnabled()) {
      response.status(503).json({
        error: {
          code: "APPLICATION_FEE_COLLECTION_DISABLED",
          message: "Production application-fee collection is not enabled."
        }
      });
      return;
    }
    try {
      const paymentId = z.string().uuid().parse(request.params.paymentId);
      let payment = await prisma.payment.findFirst({
        where: { id: paymentId, userId: request.userId!, purpose: "APPLICATION_FEE" },
        select: { id: true, amount: true, status: true, checkoutRequestId: true }
      });
      if (!payment) {
        response.status(404).json({
          error: { code: "PAYMENT_NOT_FOUND", message: "The application-fee payment could not be found." }
        });
        return;
      }
      if (payment.status === "PENDING" && payment.checkoutRequestId) {
        await refreshProductionApplicationFeeStatus(payment.id, payment.checkoutRequestId);
        payment = await prisma.payment.findUnique({
          where: { id: payment.id },
          select: { id: true, amount: true, status: true, checkoutRequestId: true }
        });
        if (!payment) {
          response.status(404).json({
            error: { code: "PAYMENT_NOT_FOUND", message: "The application-fee payment could not be found." }
          });
          return;
        }
      }
      response.json({ data: { id: payment.id, amount: payment.amount, status: payment.status } });
    } catch (error) {
      next(error);
    }
  });

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
    if (!isMpesaSandboxTestEnabled() && !isProductionApplicationFeeEnabled()) {
      sandboxDisabled(response);
      return;
    }
    if (!validMpesaCallbackToken(typeof request.query.token === "string" ? request.query.token : undefined)) {
      response.status(401).json({ error: { code: "INVALID_CALLBACK", message: "Invalid M-Pesa callback." } });
      return;
    }
    try {
      const input = stkCallbackSchema.parse(request.body);
      const checkoutRequestId = input.Body.stkCallback.CheckoutRequestID;
      const payment = await prisma.payment.findFirst({
        where: {
          checkoutRequestId,
          purpose: isProductionApplicationFeeEnabled()
            ? "APPLICATION_FEE"
            : { in: ["SANDBOX_TEST", "SANDBOX_REPAYMENT"] }
        },
        select: { id: true, purpose: true }
      });
      if (!payment) {
        response.json({ ResultCode: 0, ResultDesc: "Accepted" });
        return;
      }

      if (payment.purpose === "APPLICATION_FEE") {
        await refreshProductionApplicationFeeStatus(payment.id, checkoutRequestId, true);
      } else {
        await refreshSandboxPaymentStatus(payment.id, checkoutRequestId, true);
      }
      response.json({ ResultCode: 0, ResultDesc: "Accepted" });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
