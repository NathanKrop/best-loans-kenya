import { timingSafeEqual } from "node:crypto";

export type MpesaEnvironment = "sandbox" | "production";

export class InputError extends Error {}

export class ConfigurationError extends Error {}

export class MpesaProviderError extends Error {}

export function validMpesaCallbackToken(supplied: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = env.MPESA_CALLBACK_TOKEN || "";
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

export interface MpesaConfig {
  environment: MpesaEnvironment;
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  callbackUrl: string;
  transactionType: "CustomerPayBillOnline" | "CustomerBuyGoodsOnline";
}

export interface StkPushRequest {
  phone: string;
  amount: number;
  accountReference: string;
  transactionDesc: string;
}

export interface StkPushResponse {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string;
  ResponseDescription: string;
  CustomerMessage: string;
}

export interface StkQueryResponse {
  ResponseCode: string;
  ResponseDescription: string;
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResultCode?: string;
  ResultDesc?: string;
}

export interface B2cConfig {
  initiatorName: string;
  securityCredential: string;
  resultUrl: string;
  timeoutUrl: string;
}

export interface B2cResponse {
  ConversationID: string;
  OriginatorConversationID: string;
  ResponseCode: string;
  ResponseDescription: string;
}

type FetchLike = typeof fetch;

const BASE_URLS: Record<MpesaEnvironment, string> = {
  sandbox: "https://sandbox.safaricom.co.ke",
  production: "https://api.safaricom.co.ke"
};

export function normalizeKenyanPhone(phone: string): string {
  const compact = phone.replace(/[\s-]/g, "").replace(/^\+/, "");
  const normalized = compact.startsWith("0") ? `254${compact.slice(1)}` : compact;
  if (!/^254(?:7|1)\d{8}$/.test(normalized)) {
    throw new InputError("Enter a valid Kenyan mobile number.");
  }
  return normalized;
}

export function timestampInNairobi(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
}

export function createStkPassword(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
}

export function readMpesaConfig(env: NodeJS.ProcessEnv = process.env): MpesaConfig {
  const environment = env.MPESA_ENV;
  if (environment !== "sandbox" && environment !== "production") {
    throw new ConfigurationError("MPESA_ENV must be sandbox or production.");
  }

  const required: Array<[keyof MpesaConfig, string | undefined]> = [
    ["consumerKey", env.MPESA_CONSUMER_KEY],
    ["consumerSecret", env.MPESA_CONSUMER_SECRET],
    ["shortcode", env.MPESA_SHORTCODE],
    ["passkey", env.MPESA_PASSKEY],
    ["callbackUrl", env.MPESA_CALLBACK_URL]
  ];
  const missing = required.filter(([, value]) => !value?.trim()).map(([key]) => key);
  if (missing.length) {
    throw new ConfigurationError(`Missing M-Pesa configuration: ${missing.join(", ")}.`);
  }

  let callback: URL;
  try {
    callback = new URL(env.MPESA_CALLBACK_URL!);
  } catch {
    throw new ConfigurationError("MPESA_CALLBACK_URL must be a valid HTTPS URL.");
  }
  if (callback.protocol !== "https:") {
    throw new ConfigurationError("MPESA_CALLBACK_URL must use HTTPS.");
  }

  const transactionType = env.MPESA_TRANSACTION_TYPE || "CustomerPayBillOnline";
  if (transactionType !== "CustomerPayBillOnline" && transactionType !== "CustomerBuyGoodsOnline") {
    throw new ConfigurationError("MPESA_TRANSACTION_TYPE is not supported.");
  }

  return {
    environment,
    consumerKey: env.MPESA_CONSUMER_KEY!,
    consumerSecret: env.MPESA_CONSUMER_SECRET!,
    shortcode: env.MPESA_SHORTCODE!,
    passkey: env.MPESA_PASSKEY!,
    callbackUrl: callback.toString(),
    transactionType
  };
}

export function readB2cConfig(env: NodeJS.ProcessEnv = process.env): B2cConfig {
  const required: Array<[keyof B2cConfig, string | undefined]> = [
    ["initiatorName", env.MPESA_INITIATOR_NAME],
    ["securityCredential", env.MPESA_SECURITY_CREDENTIAL],
    ["resultUrl", env.MPESA_B2C_RESULT_URL],
    ["timeoutUrl", env.MPESA_B2C_TIMEOUT_URL]
  ];
  const missing = required.filter(([, value]) => !value?.trim()).map(([key]) => key);
  if (missing.length) {
    throw new ConfigurationError(`Missing M-Pesa B2C configuration: ${missing.join(", ")}.`);
  }
  for (const [name, value] of [
    ["MPESA_B2C_RESULT_URL", env.MPESA_B2C_RESULT_URL],
    ["MPESA_B2C_TIMEOUT_URL", env.MPESA_B2C_TIMEOUT_URL]
  ] as const) {
    let callback: URL;
    try {
      callback = new URL(value!);
    } catch {
      throw new ConfigurationError(`${name} must be a valid HTTPS URL.`);
    }
    if (callback.protocol !== "https:") {
      throw new ConfigurationError(`${name} must use HTTPS.`);
    }
  }
  return {
    initiatorName: env.MPESA_INITIATOR_NAME!,
    securityCredential: env.MPESA_SECURITY_CREDENTIAL!,
    resultUrl: env.MPESA_B2C_RESULT_URL!,
    timeoutUrl: env.MPESA_B2C_TIMEOUT_URL!
  };
}

export class MpesaClient {
  private cachedToken?: { value: string; expiresAt: number };

  constructor(
    private readonly config: MpesaConfig,
    private readonly fetcher: FetchLike = fetch,
    private readonly now: () => number = Date.now
  ) {}

  private get baseUrl(): string {
    return BASE_URLS[this.config.environment];
  }

  async accessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > this.now() + 300_000) {
      return this.cachedToken.value;
    }

    const credentials = Buffer.from(
      `${this.config.consumerKey}:${this.config.consumerSecret}`
    ).toString("base64");
    const response = await this.fetcher(
      `${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${credentials}` }, signal: AbortSignal.timeout(10_000) }
    );
    const body = await readJson(response);
    if (!response.ok || typeof body.access_token !== "string") {
      throw new MpesaProviderError("Safaricom M-Pesa authentication failed.");
    }

    const expiresIn = Number(body.expires_in);
    this.cachedToken = {
      value: body.access_token,
      expiresAt: this.now() + (Number.isFinite(expiresIn) ? expiresIn * 1000 : 3600_000)
    };
    return this.cachedToken.value;
  }

  async initiateStkPush(request: StkPushRequest): Promise<StkPushResponse> {
    const phone = normalizeKenyanPhone(request.phone);
    if (!Number.isSafeInteger(request.amount) || request.amount < 1) {
      throw new InputError("The payment amount must be a positive whole number.");
    }
    if (!/^[A-Za-z0-9._-]{1,12}$/.test(request.accountReference)) {
      throw new InputError("The account reference is invalid.");
    }
    if (!request.transactionDesc.trim() || request.transactionDesc.length > 13) {
      throw new InputError("The transaction description is invalid.");
    }

    const timestamp = timestampInNairobi(new Date(this.now()));
    const response = await this.fetcher(
      `${this.baseUrl}/mpesa/stkpush/v1/processrequest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          "Content-Type": "application/json"
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          BusinessShortCode: this.config.shortcode,
          Password: createStkPassword(this.config.shortcode, this.config.passkey, timestamp),
          Timestamp: timestamp,
          TransactionType: this.config.transactionType,
          Amount: request.amount,
          PartyA: phone,
          PartyB: this.config.shortcode,
          PhoneNumber: phone,
          CallBackURL: this.config.callbackUrl,
          AccountReference: request.accountReference,
          TransactionDesc: request.transactionDesc
        })
      }
    );
    const body = await readJson(response);
    if (
      !response.ok ||
      typeof body.MerchantRequestID !== "string" ||
      typeof body.CheckoutRequestID !== "string" ||
      typeof body.ResponseCode !== "string" ||
      typeof body.ResponseDescription !== "string" ||
      typeof body.CustomerMessage !== "string" ||
      body.ResponseCode !== "0"
    ) {
      throw new MpesaProviderError("Safaricom could not initiate the M-Pesa payment request.");
    }
    return {
      MerchantRequestID: body.MerchantRequestID,
      CheckoutRequestID: body.CheckoutRequestID,
      ResponseCode: body.ResponseCode,
      ResponseDescription: body.ResponseDescription,
      CustomerMessage: body.CustomerMessage
    };
  }

  async initiateB2c(
    request: { phone: string; amount: number; occasion: string },
    b2c: B2cConfig
  ): Promise<B2cResponse> {
    const phone = normalizeKenyanPhone(request.phone);
    if (!Number.isSafeInteger(request.amount) || request.amount < 1) {
      throw new InputError("The payment amount must be a positive whole number.");
    }
    if (!request.occasion.trim() || request.occasion.length > 100) {
      throw new InputError("The payment occasion is invalid.");
    }

    const response = await this.fetcher(
      `${this.baseUrl}/mpesa/b2c/v1/paymentrequest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          "Content-Type": "application/json"
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          InitiatorName: b2c.initiatorName,
          SecurityCredential: b2c.securityCredential,
          CommandID: "BusinessPayment",
          Amount: request.amount,
          PartyA: this.config.shortcode,
          PartyB: phone,
          Remarks: "Loan disbursement",
          QueueTimeOutURL: b2c.timeoutUrl,
          ResultURL: b2c.resultUrl,
          Occasion: request.occasion
        })
      }
    );
    const body = await readJson(response);
    if (
      !response.ok ||
      typeof body.ConversationID !== "string" ||
      typeof body.OriginatorConversationID !== "string" ||
      typeof body.ResponseCode !== "string" ||
      typeof body.ResponseDescription !== "string" ||
      body.ResponseCode !== "0"
    ) {
      throw new MpesaProviderError("Safaricom could not initiate the sandbox disbursement.");
    }
    return {
      ConversationID: body.ConversationID,
      OriginatorConversationID: body.OriginatorConversationID,
      ResponseCode: body.ResponseCode,
      ResponseDescription: body.ResponseDescription
    };
  }

  async queryStkPush(CheckoutRequestID: string): Promise<StkQueryResponse> {
    if (!CheckoutRequestID.trim()) {
      throw new TypeError("CheckoutRequestID is required.");
    }

    const timestamp = timestampInNairobi(new Date(this.now()));
    const response = await this.fetcher(
      `${this.baseUrl}/mpesa/stkpushquery/v1/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          "Content-Type": "application/json"
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          BusinessShortCode: this.config.shortcode,
          Password: createStkPassword(this.config.shortcode, this.config.passkey, timestamp),
          Timestamp: timestamp,
          CheckoutRequestID
        })
      }
    );
    const body = await readJson(response);
    if (!response.ok || typeof body.ResponseCode !== "string") {
      throw new MpesaProviderError("Safaricom could not verify the M-Pesa transaction.");
    }
    if (
      typeof body.ResponseDescription !== "string" ||
      typeof body.MerchantRequestID !== "string" ||
      typeof body.CheckoutRequestID !== "string"
    ) {
      throw new MpesaProviderError("Safaricom returned an invalid transaction status.");
    }
    return {
      ResponseCode: body.ResponseCode,
      ResponseDescription: body.ResponseDescription,
      MerchantRequestID: body.MerchantRequestID,
      CheckoutRequestID: body.CheckoutRequestID,
      ...(typeof body.ResultCode === "string" || typeof body.ResultCode === "number"
        ? { ResultCode: String(body.ResultCode) }
        : {}),
      ...(typeof body.ResultDesc === "string" ? { ResultDesc: body.ResultDesc } : {})
    };
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
