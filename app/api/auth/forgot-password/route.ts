import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resetRequestSchema } from "@/lib/validation/schemas";
import { createResetToken, RESET_TOKEN_EXPIRY_MINUTES } from "@/lib/auth/tokens";
import { sendEmail } from "@/lib/email";
import { checkRateLimit, getClientIp, RATE_LIMITS } from "@/lib/rate-limit";

// Identical to every caller regardless of whether the email has an
// account - the same anti-enumeration reasoning as signup. Nothing here
// says "sent" vs "no such account."
const SUCCESS_BODY = { message: "If that email has an account, a reset link has been sent." };
const SUCCESS_STATUS = 200;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = resetRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { email } = parsed.data;

  const { limit, windowSeconds } = RATE_LIMITS.forgotPassword;
  const ip = getClientIp(request);

  const ipCheck = await checkRateLimit(`forgot-password:ip:${ip}`, limit, windowSeconds);
  if (!ipCheck.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(ipCheck.retryAfterSeconds) } },
    );
  }

  const emailCheck = await checkRateLimit(`forgot-password:email:${email}`, limit, windowSeconds);
  if (!emailCheck.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(emailCheck.retryAfterSeconds) } },
    );
  }

  const user = await prisma.user.findUnique({ where: { email } });

  if (user) {
    const rawToken = await createResetToken(user.id);
    await sendEmail({
      to: email,
      subject: "Reset your password",
      body: `Use this link to reset your password: /reset-password?token=${rawToken}\nThis link expires in ${RESET_TOKEN_EXPIRY_MINUTES} minutes. If you didn't request this, you can ignore this email.`,
    });
  } else {
    // No account, so there is nothing to create and nowhere to send an
    // email - but returning immediately here would make this branch
    // measurably faster than the one above, which does a real database
    // write. A no-op round trip to Postgres stands in for that write, so
    // both branches pay for one database round trip before responding -
    // the same reasoning as the dummy bcrypt compare in signin.
    await prisma.$queryRaw`SELECT 1`;
  }

  return NextResponse.json(SUCCESS_BODY, { status: SUCCESS_STATUS });
}
