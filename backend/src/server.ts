import "dotenv/config";
import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import {
  contentSecurityPolicy,
  crossOriginOpenerPolicy,
  crossOriginResourcePolicy,
  originAgentCluster,
  referrerPolicy,
  strictTransportSecurity,
  xContentTypeOptions,
  xDnsPrefetchControl,
  xDownloadOptions,
  xFrameOptions,
  xPermittedCrossDomainPolicies,
  xPoweredBy,
  xXssProtection
} from "helmet";
import { ZodError } from "zod";
import { createAuthRouter, SmsProviderError } from "./auth.js";
import { prisma } from "./db.js";
import { ConfigurationError, InputError, MpesaProviderError } from "./lib/mpesa.js";
import { createLoansRouter } from "./loans.js";
import { createPaymentsRouter } from "./payments.js";
import { startPaymentReconciliation } from "./jobs/payments.js";
import { Prisma } from "@prisma/client";

const app = express();
const port = Number(process.env.PORT || 3000);
const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:8000";

app.disable("x-powered-by");
app.use(
  contentSecurityPolicy(),
  crossOriginOpenerPolicy(),
  crossOriginResourcePolicy(),
  originAgentCluster(),
  referrerPolicy(),
  strictTransportSecurity(),
  xContentTypeOptions(),
  xDnsPrefetchControl(),
  xDownloadOptions(),
  xFrameOptions(),
  xPermittedCrossDomainPolicies(),
  xPoweredBy(),
  xXssProtection()
);
app.use(cors({ origin: frontendOrigin, credentials: true }));
app.use(express.json({ limit: "32kb" }));
app.use("/api/auth", rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }));
app.use("/api/payments/registration", rateLimit({ windowMs: 10 * 60_000, limit: 3, standardHeaders: true, legacyHeaders: false }));
app.use("/api/auth", createAuthRouter(express));
app.use("/api/payments", createPaymentsRouter(express));
app.use("/api", createLoansRouter(express));

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Check the submitted fields.",
        fields: error.issues.map(issue => ({ path: issue.path, message: issue.message }))
      }
    });
    return;
  }
  if (error instanceof InputError) {
    response.status(400).json({ error: { code: "INVALID_INPUT", message: error.message } });
    return;
  }
  if (error instanceof ConfigurationError) {
    response.status(503).json({ error: { code: "SERVICE_NOT_CONFIGURED", message: error.message } });
    return;
  }
  if (error instanceof MpesaProviderError) {
    response.status(502).json({ error: { code: "PAYMENT_PROVIDER_ERROR", message: error.message } });
    return;
  }
  if (error instanceof SmsProviderError) {
    response.status(502).json({ error: { code: "SMS_PROVIDER_ERROR", message: error.message } });
    return;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    response.status(409).json({ error: { code: "ALREADY_EXISTS", message: "An account with that phone number already exists." } });
    return;
  }
  console.error("API request failed.");
  response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } });
});

await prisma.$connect();
app.listen(port, () => {
  console.log(`Best Loans API listening on port ${port}`);
  startPaymentReconciliation();
});
