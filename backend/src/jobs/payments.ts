import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { MpesaClient, readMpesaConfig } from "../lib/mpesa.js";
import { friendlyFailure } from "../payments.js";

function isFailureResult(code: number): "FAILED" | "CANCELLED" | "TIMEOUT" {
  return code === 1032 ? "CANCELLED" : code === 1037 ? "TIMEOUT" : "FAILED";
}

export async function reconcilePendingPayments(): Promise<void> {
  const cutoff = new Date(Date.now() - 2 * 60_000);
  const expireAt = new Date(Date.now() - 10 * 60_000);
  const pending = await prisma.payment.findMany({
    where: { status: "PENDING", createdAt: { lte: cutoff } },
    orderBy: { createdAt: "asc" },
    take: 50
  });
  if (!pending.length) return;

  const client = new MpesaClient(readMpesaConfig());
  for (const payment of pending) {
    try {
      if (!payment.checkoutRequestId) {
        if (payment.createdAt <= expireAt) {
          await prisma.payment.updateMany({
            where: { id: payment.id, status: "PENDING" },
            data: {
              status: "TIMEOUT",
              pendingKey: null,
              resultDesc: "The payment request could not be confirmed. Contact support before trying again."
            }
          });
        }
        continue;
      }

      const query = await client.queryStkPush(payment.checkoutRequestId);
      if (query.ResponseCode !== "0" || query.CheckoutRequestID !== payment.checkoutRequestId) {
        if (payment.createdAt <= expireAt) {
          await prisma.payment.updateMany({
            where: { id: payment.id, status: "PENDING" },
            data: { status: "TIMEOUT", pendingKey: null, resultDesc: "Safaricom did not confirm the payment request." }
          });
        }
        continue;
      }

      if (query.ResultCode === undefined) {
        if (payment.createdAt <= expireAt) {
          await prisma.payment.updateMany({
            where: { id: payment.id, status: "PENDING" },
            data: { status: "TIMEOUT", pendingKey: null, resultDesc: "The payment request timed out." }
          });
        }
        continue;
      }

      const resultCode = Number(query.ResultCode);
      if (!Number.isInteger(resultCode)) continue;
      if (resultCode !== 0) {
        await prisma.payment.updateMany({
          where: { id: payment.id, status: "PENDING" },
          data: {
            status: isFailureResult(resultCode),
            pendingKey: null,
            resultCode,
            resultDesc: friendlyFailure(resultCode)
          }
        });
        continue;
      }

      await prisma.$transaction(async (transaction: Prisma.TransactionClient) => {
        const current = await transaction.payment.findUnique({ where: { id: payment.id } });
        if (!current || current.status !== "PENDING") return;
        await transaction.payment.update({
          where: { id: payment.id },
          data: {
            status: "SUCCESS",
            pendingKey: null,
            resultCode: 0,
            resultDesc: "Payment verified by Safaricom. Receipt details are pending."
          }
        });
        await transaction.user.update({
          where: { id: payment.userId },
          data: { registrationPaidAt: new Date() }
        });
      });
    } catch {
      console.error("Pending M-Pesa payment could not be reconciled.");
    }
  }
}

export function startPaymentReconciliation(): void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await reconcilePendingPayments();
    } catch {
      console.error("M-Pesa reconciliation job failed.");
    } finally {
      running = false;
    }
  };
  void run();
  setInterval(() => void run(), 2 * 60_000);
}
