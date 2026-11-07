import type { AuthenticatedRequest } from "./auth.js";
import { requireAdmin, requireUser } from "./auth.js";
import { prisma } from "./db.js";
import {
  isConfirmedDisbursementResult,
  isLoanSandboxEnabled,
  canAcceptLoanOffer,
  canStartRepayment,
  createLoanOfferTerms,
  dueDateFromDisbursement
} from "./loan-workflow-domain.js";
import {
  ConfigurationError,
  MpesaClient,
  MpesaProviderError,
  normalizeKenyanPhone,
  readB2cConfig,
  readMpesaConfig,
  validMpesaCallbackToken
} from "./lib/mpesa.js";
import { z } from "zod";

const offerSchema = z.object({
  approvedAmount: z.number().int().positive(),
  note: z.string().trim().min(3).max(1000)
});

const decisionNoteSchema = z.object({ note: z.string().trim().min(3).max(1000) });
const acceptSchema = z.object({ phone: z.string().min(9).max(16), acceptTerms: z.literal(true) });
const callbackSchema = z.object({
  Result: z.object({
    ConversationID: z.string().min(1).max(128),
    OriginatorConversationID: z.string().min(1).max(128),
    ResultCode: z.union([z.number(), z.string()]),
    ResultDesc: z.string().max(1000),
    ResultParameters: z.object({
      ResultParameter: z.array(z.object({
        Key: z.string(),
        Value: z.union([z.string(), z.number()])
      })).optional()
    }).optional()
  })
});

function workflowEnabled(): boolean {
  return isLoanSandboxEnabled(process.env);
}

function sandboxUnavailable(response: import("express").Response): void {
  response.status(503).json({
    error: {
      code: "LOAN_SANDBOX_DISABLED",
      message: "The loan lifecycle is disabled unless the M-Pesa sandbox and loan sandbox mode are explicitly enabled."
    }
  });
}

function mpesaClient(): MpesaClient {
  const config = readMpesaConfig();
  if (config.environment !== "sandbox") {
    throw new ConfigurationError("Loan workflow transactions are restricted to the M-Pesa sandbox.");
  }
  return new MpesaClient(config);
}

async function updateRepaymentState(
  paymentId: string,
  resultCode: number,
  resultDesc: string | undefined,
  callbackReceived: boolean
): Promise<void> {
  await prisma.$transaction(async transaction => {
    const updated = await transaction.payment.updateMany({
      where: { id: paymentId, status: "PENDING" },
      data: {
        status: resultCode === 0 ? "SUCCESS" : resultCode === 1032 ? "CANCELLED" : resultCode === 1037 ? "TIMEOUT" : "FAILED",
        resultCode,
        resultDesc,
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

export function createLoanWorkflowRouter(express: typeof import("express")) {
  const router = express.Router();

  router.get("/admin/loan-applications", requireAdmin, async (request, response, next) => {
    if (!workflowEnabled()) {
      sandboxUnavailable(response);
      return;
    }
    try {
      const applications = await prisma.loanApplication.findMany({
        where: { status: "PENDING" },
        orderBy: { createdAt: "asc" },
        take: 100,
        select: {
          id: true,
          amount: true,
          periodDays: true,
          purpose: true,
          createdAt: true,
          user: {
            select: {
              fullName: true,
              email: true,
              phone: true,
              profile: { select: { dateOfBirth: true, county: true, monthlyIncomeRange: true } }
            }
          }
        }
      });
      response.json({ data: applications });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/loan-applications/:applicationId/offer", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    if (!workflowEnabled()) {
      sandboxUnavailable(response);
      return;
    }
    try {
      const applicationId = z.string().uuid().parse(request.params.applicationId);
      const input = offerSchema.parse(request.body);
      const application = await prisma.loanApplication.findUnique({
        where: { id: applicationId },
        select: { id: true, amount: true, periodDays: true, status: true }
      });
      if (!application) {
        response.status(404).json({ error: { code: "APPLICATION_NOT_FOUND", message: "Application not found." } });
        return;
      }
      const terms = createLoanOfferTerms(application.amount, input.approvedAmount, application.periodDays);
      const offer = await prisma.$transaction(async transaction => {
        const claimed = await transaction.loanApplication.updateMany({
          where: { id: application.id, status: "PENDING" },
          data: { status: "OFFERED" }
        });
        if (claimed.count !== 1) return null;
        const created = await transaction.loanOffer.create({
          data: { applicationId, ...terms, note: input.note, offeredByUserId: request.userId! }
        });
        await transaction.loanAuditLog.create({
          data: {
            applicationId,
            actorUserId: request.userId!,
            action: "OFFER_CREATED",
            note: `Approved principal KES ${terms.approvedAmount}; flat interest KES ${terms.interestAmount}; total repayment KES ${terms.repaymentAmount}; due ${terms.termDays} days after confirmed disbursement. ${input.note}`
          }
        });
        return created;
      });
      if (!offer) {
        response.status(409).json({ error: { code: "APPLICATION_ALREADY_DECIDED", message: "This application is no longer pending review." } });
        return;
      }
      response.status(201).json({
        data: {
          id: offer.id,
          status: offer.status,
          ...terms,
          dueDescription: `${terms.termDays} days after confirmed disbursement`,
          note: offer.note
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/loan-applications/:applicationId/reject", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    if (!workflowEnabled()) {
      sandboxUnavailable(response);
      return;
    }
    try {
      const applicationId = z.string().uuid().parse(request.params.applicationId);
      const { note } = decisionNoteSchema.parse(request.body);
      const result = await prisma.$transaction(async transaction => {
        const changed = await transaction.loanApplication.updateMany({
          where: { id: applicationId, status: "PENDING" },
          data: { status: "REJECTED" }
        });
        if (changed.count !== 1) return false;
        await transaction.loanAuditLog.create({
          data: { applicationId, actorUserId: request.userId!, action: "APPLICATION_REJECTED", note }
        });
        return true;
      });
      if (!result) {
        response.status(409).json({ error: { code: "APPLICATION_ALREADY_DECIDED", message: "This application is no longer pending review." } });
        return;
      }
      response.json({ data: { applicationId, status: "REJECTED" } });
    } catch (error) {
      next(error);
    }
  });

  router.get("/loans/offers/me", requireUser, async (request: AuthenticatedRequest, response, next) => {
    try {
      const offers = await prisma.loanOffer.findMany({
        where: { application: { userId: request.userId } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          approvedAmount: true,
          interestBasisPoints: true,
          interestAmount: true,
          repaymentAmount: true,
          termDays: true,
          status: true,
          note: true,
          acceptedAt: true,
          disbursedAt: true,
          dueAt: true,
          repaidAt: true,
          application: { select: { id: true, purpose: true } },
          payments: {
            orderBy: { createdAt: "desc" },
            take: 5,
            select: { id: true, purpose: true, amount: true, status: true, createdAt: true }
          }
        }
      });
      response.json({ data: offers });
    } catch (error) {
      next(error);
    }
  });

  router.post("/loans/offers/:offerId/accept", requireUser, async (request: AuthenticatedRequest, response, next) => {
    if (!workflowEnabled()) {
      sandboxUnavailable(response);
      return;
    }
    try {
      const b2cConfig = readB2cConfig();
      const client = mpesaClient();
      const offerId = z.string().uuid().parse(request.params.offerId);
      const input = acceptSchema.parse(request.body);
      const phone = normalizeKenyanPhone(input.phone);
      const created = await prisma.$transaction(async transaction => {
        const offer = await transaction.loanOffer.findFirst({
          where: { id: offerId, application: { userId: request.userId } },
          select: { id: true, status: true, approvedAmount: true, applicationId: true }
        });
        if (!offer || !canAcceptLoanOffer(offer.status)) return null;
        const claimed = await transaction.loanOffer.updateMany({
          where: { id: offerId, status: offer.status },
          data: { status: "DISBURSEMENT_PENDING", acceptedAt: new Date() }
        });
        if (claimed.count !== 1) return null;
        const payment = await transaction.payment.create({
          data: {
            userId: request.userId!,
            loanOfferId: offerId,
            pendingKey: `${offerId}:SANDBOX_DISBURSEMENT`,
            purpose: "SANDBOX_DISBURSEMENT",
            amount: offer.approvedAmount,
            phone
          },
          select: { id: true }
        });
        await transaction.loanAuditLog.create({
          data: {
            applicationId: offer.applicationId,
            actorUserId: request.userId!,
            action: offer.status === "OFFERED" ? "OFFER_ACCEPTED" : "DISBURSEMENT_RETRIED",
            note: offer.status === "OFFERED"
              ? "Borrower accepted the written offer; sandbox disbursement initiated."
              : "Borrower retried the previously failed sandbox disbursement."
          }
        });
        return { paymentId: payment.id, amount: offer.approvedAmount, phone };
      });
      if (!created) {
        response.status(409).json({ error: { code: "OFFER_NOT_AVAILABLE", message: "This offer is no longer available to accept." } });
        return;
      }

      const result = await client.initiateB2c(
        { phone: created.phone, amount: created.amount, occasion: created.paymentId.replaceAll("-", "").slice(0, 20) },
        b2cConfig
      );
      await prisma.payment.update({
        where: { id: created.paymentId },
        data: {
          merchantRequestId: result.OriginatorConversationID,
          checkoutRequestId: result.ConversationID
        }
      });
      response.status(202).json({
        data: {
          paymentId: created.paymentId,
          status: "PENDING",
          message: "Offer accepted. Sandbox disbursement is pending Safaricom confirmation."
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/loans/offers/:offerId/decline", requireUser, async (request: AuthenticatedRequest, response, next) => {
    if (!workflowEnabled()) {
      sandboxUnavailable(response);
      return;
    }
    try {
      const offerId = z.string().uuid().parse(request.params.offerId);
      const changed = await prisma.$transaction(async transaction => {
        const offer = await transaction.loanOffer.findFirst({
          where: { id: offerId, application: { userId: request.userId }, status: "OFFERED" },
          select: { id: true, applicationId: true }
        });
        if (!offer) return false;
        const declined = await transaction.loanOffer.updateMany({
          where: { id: offerId, status: "OFFERED" },
          data: { status: "DECLINED" }
        });
        if (declined.count !== 1) return false;
        await transaction.loanAuditLog.create({
          data: {
            applicationId: offer.applicationId,
            actorUserId: request.userId!,
            action: "OFFER_DECLINED",
            note: "Borrower declined the written offer."
          }
        });
        return true;
      });
      if (!changed) {
        response.status(409).json({ error: { code: "OFFER_NOT_AVAILABLE", message: "This offer is no longer available to decline." } });
        return;
      }
      response.json({ data: { id: offerId, status: "DECLINED" } });
    } catch (error) {
      next(error);
    }
  });

  router.post("/loans/offers/:offerId/repayment", requireUser, async (request: AuthenticatedRequest, response, next) => {
    if (!workflowEnabled()) {
      sandboxUnavailable(response);
      return;
    }
    try {
      const client = mpesaClient();
      const offerId = z.string().uuid().parse(request.params.offerId);
      const phoneInput = z.object({ phone: z.string().min(9).max(16) }).parse(request.body);
      const phone = normalizeKenyanPhone(phoneInput.phone);
      const created = await prisma.$transaction(async transaction => {
        const offer = await transaction.loanOffer.findFirst({
          where: { id: offerId, application: { userId: request.userId } },
          select: { id: true, status: true, repaymentAmount: true }
        });
        if (!offer || !canStartRepayment(offer.status)) return null;
        const payment = await transaction.payment.create({
          data: {
            userId: request.userId!,
            loanOfferId: offerId,
            pendingKey: `${offerId}:SANDBOX_REPAYMENT`,
            purpose: "SANDBOX_REPAYMENT",
            amount: offer.repaymentAmount,
            phone
          },
          select: { id: true }
        });
        return { paymentId: payment.id, amount: offer.repaymentAmount };
      });
      if (!created) {
        response.status(409).json({ error: { code: "LOAN_NOT_REPAYABLE", message: "Only a disbursed, unpaid loan can be repaid." } });
        return;
      }

      const result = await client.initiateStkPush({
        phone,
        amount: created.amount,
        accountReference: `DC${created.paymentId.replaceAll("-", "").slice(0, 10)}`,
        transactionDesc: "Loan repay"
      });
      await prisma.payment.update({
        where: { id: created.paymentId },
        data: { merchantRequestId: result.MerchantRequestID, checkoutRequestId: result.CheckoutRequestID }
      });
      response.status(202).json({
        data: {
          paymentId: created.paymentId,
          amount: created.amount,
          status: "PENDING",
          customerMessage: result.CustomerMessage
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/payments/loan/:paymentId/status", requireUser, async (request: AuthenticatedRequest, response, next) => {
    if (!workflowEnabled()) {
      sandboxUnavailable(response);
      return;
    }
    try {
      const paymentId = z.string().uuid().parse(request.params.paymentId);
      let payment = await prisma.payment.findFirst({
        where: {
          id: paymentId,
          userId: request.userId,
          purpose: { in: ["SANDBOX_DISBURSEMENT", "SANDBOX_REPAYMENT"] }
        },
        select: {
          id: true,
          purpose: true,
          amount: true,
          status: true,
          checkoutRequestId: true,
          createdAt: true,
          loanOffer: { select: { status: true, dueAt: true, repaymentAmount: true } }
        }
      });
      if (!payment) {
        response.status(404).json({ error: { code: "PAYMENT_NOT_FOUND", message: "Loan transaction not found." } });
        return;
      }
      if (payment.purpose === "SANDBOX_REPAYMENT" && payment.status === "PENDING" && payment.checkoutRequestId) {
        const result = await mpesaClient().queryStkPush(payment.checkoutRequestId);
        if (result.CheckoutRequestID !== payment.checkoutRequestId) {
          throw new MpesaProviderError("Safaricom returned a mismatched M-Pesa transaction.");
        }
        if (result.ResultCode !== undefined && /^\d+$/.test(result.ResultCode)) {
          await updateRepaymentState(payment.id, Number(result.ResultCode), result.ResultDesc, false);
          payment = await prisma.payment.findUnique({
            where: { id: payment.id },
            select: {
              id: true,
              purpose: true,
              amount: true,
              status: true,
              checkoutRequestId: true,
              createdAt: true,
              loanOffer: { select: { status: true, dueAt: true, repaymentAmount: true } }
            }
          });
          if (!payment) {
            response.status(404).json({ error: { code: "PAYMENT_NOT_FOUND", message: "Loan transaction not found." } });
            return;
          }
        }
      }
      response.json({
        data: {
          id: payment.id,
          purpose: payment.purpose,
          amount: payment.amount,
          status: payment.status,
          loanStatus: payment.loanOffer?.status,
          dueAt: payment.loanOffer?.dueAt,
          createdAt: payment.createdAt
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/payments/mpesa/b2c/result", async (request, response, next) => {
    if (!workflowEnabled()) {
      sandboxUnavailable(response);
      return;
    }
    if (!validMpesaCallbackToken(typeof request.query.token === "string" ? request.query.token : undefined)) {
      response.status(401).json({ error: { code: "INVALID_CALLBACK", message: "Invalid M-Pesa callback." } });
      return;
    }
    try {
      const input = callbackSchema.parse(request.body);
      const result = input.Result;
      const payment = await prisma.payment.findFirst({
        where: {
          merchantRequestId: result.OriginatorConversationID,
          checkoutRequestId: result.ConversationID,
          purpose: "SANDBOX_DISBURSEMENT",
          status: "PENDING"
        },
        select: { id: true, loanOfferId: true, amount: true, phone: true, userId: true }
      });
      if (!payment) {
        response.json({ ResultCode: 0, ResultDesc: "Accepted" });
        return;
      }
      const callbackCode = Number(result.ResultCode);
      if (!Number.isSafeInteger(callbackCode) || callbackCode < 0) {
        throw new MpesaProviderError("Safaricom returned an invalid disbursement result.");
      }
      const receipt = result.ResultParameters?.ResultParameter?.find(
        parameter => parameter.Key === "TransactionReceipt"
      )?.Value;
      const callbackAmount = result.ResultParameters?.ResultParameter?.find(
        parameter => parameter.Key === "TransactionAmount"
      )?.Value;
      if (typeof receipt === "string" && isConfirmedDisbursementResult(callbackCode, receipt, callbackAmount, payment.amount)) {
        const receiptNumber = receipt;
        await prisma.$transaction(async transaction => {
          const updated = await transaction.payment.updateMany({
            where: { id: payment.id, status: "PENDING" },
            data: {
              status: "SUCCESS",
              resultCode: callbackCode,
              resultDesc: result.ResultDesc,
              mpesaReceiptNumber: receiptNumber,
              transactionDate: new Date(),
              callbackReceivedAt: new Date(),
              pendingKey: null
            }
          });
          if (updated.count === 1 && payment.loanOfferId) {
            const offer = await transaction.loanOffer.findUnique({
              where: { id: payment.loanOfferId },
              select: { termDays: true, applicationId: true }
            });
            if (offer) {
              const disbursedAt = new Date();
              const activated = await transaction.loanOffer.updateMany({
                where: { id: payment.loanOfferId, status: "DISBURSEMENT_PENDING" },
                data: {
                  status: "ACTIVE",
                  disbursedAt,
                  dueAt: dueDateFromDisbursement(disbursedAt, offer.termDays)
                }
              });
              if (activated.count === 1) {
                await transaction.loanAuditLog.create({
                  data: {
                    applicationId: offer.applicationId,
                    actorUserId: payment.userId,
                    action: "DISBURSEMENT_CONFIRMED",
                    note: `Sandbox disbursement confirmed for KES ${payment.amount}; receipt ${receiptNumber}.`
                  }
                });
              }
            }
          }
        });
      } else if (callbackCode !== 0) {
        await prisma.$transaction(async transaction => {
          const updated = await transaction.payment.updateMany({
            where: { id: payment.id, status: "PENDING" },
            data: {
              status: "FAILED",
              resultCode: callbackCode,
              resultDesc: result.ResultDesc,
              callbackReceivedAt: new Date(),
              pendingKey: null
            }
          });
          if (updated.count === 1 && payment.loanOfferId) {
            const offer = await transaction.loanOffer.findUnique({
              where: { id: payment.loanOfferId },
              select: { applicationId: true }
            });
            const failed = await transaction.loanOffer.updateMany({
              where: { id: payment.loanOfferId, status: "DISBURSEMENT_PENDING" },
              data: { status: "DISBURSEMENT_FAILED" }
            });
            if (failed.count === 1 && offer) {
              await transaction.loanAuditLog.create({
                data: {
                  applicationId: offer.applicationId,
                  actorUserId: payment.userId,
                  action: "DISBURSEMENT_FAILED",
                  note: `Sandbox disbursement was not completed. Safaricom result: ${result.ResultDesc}.`
                }
              });
            }
          }
        });
      } else {
        throw new MpesaProviderError("The disbursement callback did not include matching receipt and amount details.");
      }
      response.json({ ResultCode: 0, ResultDesc: "Accepted" });
    } catch (error) {
      next(error);
    }
  });

  router.post("/payments/mpesa/b2c/timeout", (request, response) => {
    if (!validMpesaCallbackToken(typeof request.query.token === "string" ? request.query.token : undefined)) {
      response.status(401).json({ error: { code: "INVALID_CALLBACK", message: "Invalid M-Pesa callback." } });
      return;
    }
    response.json({ ResultCode: 0, ResultDesc: "Accepted; transaction remains pending verification" });
  });

  return router;
}
