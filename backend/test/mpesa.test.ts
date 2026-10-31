import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createStkPassword,
  MpesaClient,
  normalizeKenyanPhone,
  readMpesaConfig,
  timestampInNairobi
} from "../src/lib/mpesa.js";

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
  const token = await client.accessToken();

  assert.equal(first.CheckoutRequestID, "checkout-1");
  assert.equal(token, "token");
  assert.equal(calls, 2);
  assert.equal(pushedBody?.PartyA, "254712345678");
  assert.equal(pushedBody?.Amount, 250);
});
