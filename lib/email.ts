interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
}

// The only function in this codebase that sends email. Verification codes,
// reset links, and the "someone tried to sign up with your address" notice
// all go through this one function, so swapping in a real provider later
// (Postmark, Resend, SES...) is a one-file change - nothing that calls
// sendEmail() needs to know it changed.
export async function sendEmail({ to, subject, body }: SendEmailInput): Promise<void> {
  console.log(
    [
      "",
      "========== EMAIL ==========",
      `To:      ${to}`,
      `Subject: ${subject}`,
      "----------------------------",
      body,
      "============================",
      "",
    ].join("\n"),
  );
}
