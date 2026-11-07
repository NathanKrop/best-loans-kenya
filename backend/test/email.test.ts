import assert from "node:assert/strict";
import { test } from "node:test";
import { EmailProviderError, sendVerificationEmail } from "../src/lib/email.js";

test("sends a verification code through Resend", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
  };

  await sendVerificationEmail(
    "customer@example.com",
    "123456",
    { NODE_ENV: "production", RESEND_API_KEY: "test-key", EMAIL_FROM: "DeniCash <verify@example.com>" },
    fetcher
  );

  assert.equal(requestUrl, "https://api.resend.com/emails");
  assert.equal(new Headers(requestInit?.headers).get("authorization"), "Bearer test-key");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    from: "DeniCash <verify@example.com>",
    to: ["customer@example.com"],
    subject: "Your DeniCash verification code",
    text: "Your verification code is 123456. It expires in 5 minutes. If you did not request this code, you can ignore this email."
  });
});

test("requires Resend configuration outside the local OTP bypass", async () => {
  await assert.rejects(
    sendVerificationEmail("customer@example.com", "123456", { NODE_ENV: "production" }),
    EmailProviderError
  );
});

test("the fixed development OTP bypass does not send email", async () => {
  let requestCount = 0;
  const fetcher: typeof fetch = async () => {
    requestCount += 1;
    return new Response(null, { status: 200 });
  };

  await sendVerificationEmail(
    "customer@example.com",
    "123456",
    { NODE_ENV: "development", DEV_OTP_CODE: "123456" },
    fetcher
  );

  assert.equal(requestCount, 0);
});

test("does not bypass email delivery in production", async () => {
  let requestCount = 0;
  const fetcher: typeof fetch = async () => {
    requestCount += 1;
    return new Response(null, { status: 200 });
  };

  await sendVerificationEmail(
    "customer@example.com",
    "123456",
    { NODE_ENV: "production", DEV_OTP_CODE: "123456", RESEND_API_KEY: "test-key", EMAIL_FROM: "verify@example.com" },
    fetcher
  );

  assert.equal(requestCount, 1);
});

test("reports Resend and network failures", async () => {
  const env = { NODE_ENV: "production", RESEND_API_KEY: "test-key", EMAIL_FROM: "verify@example.com" };
  await assert.rejects(
    sendVerificationEmail("customer@example.com", "123456", env, async () => new Response(null, { status: 503 })),
    EmailProviderError
  );
  await assert.rejects(
    sendVerificationEmail("customer@example.com", "123456", env, async () => {
      throw new Error("network unavailable");
    }),
    EmailProviderError
  );
});
