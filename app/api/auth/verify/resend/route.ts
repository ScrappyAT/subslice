import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resendCodeSchema } from "@/lib/validation/schemas";
import { createVerificationCode, getResendCooldownRemaining, CODE_EXPIRY_MINUTES } from "@/lib/auth/codes";
import { sendEmail } from "@/lib/email";
import { checkRateLimit, getClientIp, RATE_LIMITS } from "@/lib/rate-limit";

// Identical whether the email has no account, is already verified, or is
// still inside its cooldown - none of those are this endpoint's business
// to reveal to whoever is asking.
const SUCCESS_BODY = { message: "If that email has an unverified account, a new code has been sent." };
const SUCCESS_STATUS = 200;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = resendCodeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { email } = parsed.data;

  // The brief singles this endpoint out by name: it is the one that costs
  // real money once sendEmail() is backed by a real provider, so it gets
  // its own rate limit on top of the separate resend cooldown.
  const { limit, windowSeconds } = RATE_LIMITS.verifyResend;
  const ip = getClientIp(request);

  const ipCheck = await checkRateLimit(`verify-resend:ip:${ip}`, limit, windowSeconds);
  if (!ipCheck.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(ipCheck.retryAfterSeconds) } },
    );
  }

  const emailCheck = await checkRateLimit(`verify-resend:email:${email}`, limit, windowSeconds);
  if (!emailCheck.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(emailCheck.retryAfterSeconds) } },
    );
  }

  const user = await prisma.user.findUnique({ where: { email } });

  if (user && !user.emailVerifiedAt) {
    const cooldownRemaining = await getResendCooldownRemaining(user.id);
    if (cooldownRemaining === 0) {
      const verificationCode = await createVerificationCode(user.id);
      await sendEmail({
        to: email,
        subject: "Verify your email",
        body: `Your verification code is ${verificationCode.code}. It expires in ${CODE_EXPIRY_MINUTES} minutes.`,
      });
    }
    // Still inside the cooldown: nothing sent, same response regardless -
    // the cooldown is enforced by silently doing nothing, not by telling
    // the caller "wait N more seconds," which would help someone probing
    // for account existence/timing more than it helps a real user.
  } else {
    // No account, or already verified - no code to create, nowhere to
    // send anything. A no-op round trip stands in for the work the
    // eligible branch would have done, so this path isn't measurably
    // faster - the same reasoning as forgot-password's dummy query.
    await prisma.$queryRaw`SELECT 1`;
  }

  return NextResponse.json(SUCCESS_BODY, { status: SUCCESS_STATUS });
}
