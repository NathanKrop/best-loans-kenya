import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createStkPassword,
  MpesaClient,
  normalizeKenyanPhone,
  readB2cConfig,
  readMpesaConfig,
  timestampInNairobi,
  validMpesaCallbackToken
} from "../src/lib/mpesa.js";
import { isMpesaSandboxTestEnabled, paymentStatusForMpesaResult } from "../src/payments.js";

const config = {
  environment: "sandbox" as const,
  consumerKey: "test-key",
  consumerSecret: "test-secret",
  shortcode: "174379",
  passkey: "test-passkey",
  callbackUrl: "https://example.test/api/payments/mpesa/callback",
  transactionType: "CustomerPayBillOnline" as const
};

test("normalizes valid Kenyan mobile formats and rejects invalid numbers", () => {
  assert.equal(normalizeKenyanPhone("0712 345 678"), "254712345678");
  assert.equal(normalizeKenyanPhone("0112 345 678"), "254112345678");
  assert.equal(normalizeKenyanPhone("+254 712 345 678"), "254712345678");
  assert.equal(normalizeKenyanPhone("+254 112 345 678"), "254112345678");
  assert.throws(() => normalizeKenyanPhone("12345"), /valid Kenyan mobile/);
});

test("formats Daraja timestamps using Nairobi time", () => {
  assert.equal(timestampInNairobi(new Date("2026-01-01T00:00:00.000Z")), "20260101030000");
});

test("creates the Daraja STK password", () => {
  assert.equal(
    createStkPassword("174379", "passkey", "20260101030000"),
    Buffer.from("174379passkey20260101030000").toString("base64")
  );
});

test("requires HTTPS callback URLs and supported configuration", () => {
  assert.throws(() => readMpesaConfig({
    MPESA_ENV: "sandbox",
    MPESA_CONSUMER_KEY: "key",
    MPESA_CONSUMER_SECRET: "secret",
    MPESA_SHORTCODE: "123",
    MPESA_PASSKEY: "pass",
    MPESA_CALLBACK_URL: "http://localhost/callback"
  }), /must use HTTPS/);
});

test("authenticates payment callbacks with the configured shared token", () => {
  const env = { MPESA_CALLBACK_TOKEN: "private-callback-token" };
  assert.equal(validMpesaCallbackToken("private-callback-token", env), true);
  assert.equal(validMpesaCallbackToken("wrong-token", env), false);
  assert.equal(validMpesaCallbackToken(undefined, env), false);
  assert.equal(validMpesaCallbackToken("private-callback-token", {}), false);
});

test("requires HTTPS result and timeout callbacks for sandbox disbursements", () => {
  assert.throws(() => readB2cConfig({
    MPESA_INITIATOR_NAME: "initiator",
    MPESA_SECURITY_CREDENTIAL: "credential",
    MPESA_B2C_RESULT_URL: "http://example.test/result",
    MPESA_B2C_TIMEOUT_URL: "https://example.test/timeout"
  }), /MPESA_B2C_RESULT_URL must use HTTPS/);
  assert.deepEqual(readB2cConfig({
    MPESA_INITIATOR_NAME: "initiator",
    MPESA_SECURITY_CREDENTIAL: "credential",
    MPESA_B2C_RESULT_URL: "https://example.test/result",
    MPESA_B2C_TIMEOUT_URL: "https://example.test/timeout"
  }), {
    initiatorName: "initiator",
    securityCredential: "credential",
    resultUrl: "https://example.test/result",
    timeoutUrl: "https://example.test/timeout"
  });
});

test("sandbox test payments require both sandbox environment and explicit opt-in", () => {
  assert.equal(isMpesaSandboxTestEnabled({ MPESA_ENV: "sandbox" }), false);
  assert.equal(isMpesaSandboxTestEnabled({ MPESA_ENV: "production", MPESA_SANDBOX_TEST_MODE: "true" }), false);
  assert.equal(isMpesaSandboxTestEnabled({ MPESA_ENV: "sandbox", MPESA_SANDBOX_TEST_MODE: "true" }), true);
});

test("maps verified Daraja result codes to payment states", () => {
  assert.equal(paymentStatusForMpesaResult(0), "SUCCESS");
  assert.equal(paymentStatusForMpesaResult(1032), "CANCELLED");
  assert.equal(paymentStatusForMpesaResult(1037), "TIMEOUT");
  assert.equal(paymentStatusForMpesaResult(1), "FAILED");
});

test("caches the access token and sends a valid STK request", async () => {
  let calls = 0;
  let pushedBody: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    calls += 1;
    const url = String(input);
    if (url.includes("/oauth/")) {
      return new Response(JSON.stringify({ access_token: "token", expires_in: "3600" }), { status: 200 });
    }
    pushedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      MerchantRequestID: "merchant-1",
      CheckoutRequestID: "checkout-1",
      ResponseCode: "0",
      ResponseDescription: "Accepted",
      CustomerMessage: "Success. Request accepted for processing"
    }), { status: 200 });
  };
  const client = new MpesaClient(config, fetcher, () => Date.parse("2026-01-01T00:00:00.000Z"));

  const first = await client.initiateStkPush({
    phone: "0712345678",
    amount: 250,
    accountReference: "BLK-user1",
    transactionDesc: "Registration"
  });

  test("initiates a B2C sandbox disbursement to the normalized borrower number", async () => {
    let pushedBody: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).includes("/oauth/")) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: "3600" }), { status: 200 });
      }
      pushedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        ConversationID: "conversation-1",
        OriginatorConversationID: "originator-1",
        ResponseCode: "0",
        ResponseDescription: "Accept the service request successfully."
      }), { status: 200 });
    };
    const client = new MpesaClient(config, fetcher, () => Date.parse("2026-01-01T00:00:00.000Z"));
    const b2c = {
      initiatorName: "initiator",
      securityCredential: "credential",
      resultUrl: "https://example.test/result",
      timeoutUrl: "https://example.test/timeout"
    };

    const result = await client.initiateB2c(
      { phone: "0712345678", amount: 10_000, occasion: "loan123" },
      b2c
    );

    assert.equal(result.ConversationID, "conversation-1");
    assert.equal(pushedBody?.CommandID, "BusinessPayment");
    assert.equal(pushedBody?.PartyA, "174379");
    assert.equal(pushedBody?.PartyB, "254712345678");
    assert.equal(pushedBody?.Amount, 10_000);
    assert.equal(pushedBody?.ResultURL, b2c.resultUrl);
  });
  const token = await client.accessToken();

  assert.equal(first.CheckoutRequestID, "checkout-1");
  assert.equal(token, "token");
  assert.equal(calls, 2);
  assert.equal(pushedBody?.PartyA, "254712345678");
  assert.equal(pushedBody?.Amount, 250);
});
