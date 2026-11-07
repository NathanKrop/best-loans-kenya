export class EmailProviderError extends Error {}

export async function sendVerificationEmail(
  email: string,
  code: string,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch
): Promise<void> {
  if (env.NODE_ENV !== "production" && env.DEV_OTP_CODE) return;

  const apiKey = env.RESEND_API_KEY;
  const from = env.EMAIL_FROM;
  if (!apiKey || !from) {
    throw new EmailProviderError("Email delivery is not configured. Set RESEND_API_KEY and EMAIL_FROM.");
  }

  let response: Response;
  try {
    response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        from,
        to: [email],
        subject: "Your DeniCash verification code",
        text: `Your verification code is ${code}. It expires in 5 minutes. If you did not request this code, you can ignore this email.`
      })
    });
  } catch (error) {
    throw new EmailProviderError("Email provider could not deliver the verification code.", { cause: error });
  }

  if (!response.ok) {
    throw new EmailProviderError("Email provider could not deliver the verification code.");
  }
}
