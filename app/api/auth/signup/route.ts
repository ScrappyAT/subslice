import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { signupSchema } from "@/lib/validation/schemas";
import { hashPassword } from "@/lib/auth/password";
import { createVerificationCode, CODE_EXPIRY_MINUTES } from "@/lib/auth/codes";
import { sendEmail } from "@/lib/email";
import { checkRateLimit, getClientIp, RATE_LIMITS } from "@/lib/rate-limit";

// Every successful call to this endpoint gets this exact body and status,
// whether this specific request is the one that inserted the row or the
// email already had an account. A signup endpoint that answers
// differently for "new" vs "taken" lets an attacker enumerate which
// addresses have accounts just by submitting them here.
const SUCCESS_BODY = { message: "Account created." };
const SUCCESS_STATUS = 201;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { email, password, name } = parsed.data;

  const { limit, windowSeconds } = RATE_LIMITS.signup;
  const ip = getClientIp(request);

  const ipCheck = await checkRateLimit(`signup:ip:${ip}`, limit, windowSeconds);
  if (!ipCheck.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(ipCheck.retryAfterSeconds) } },
    );
  }

  const emailCheck = await checkRateLimit(`signup:email:${email}`, limit, windowSeconds);
  if (!emailCheck.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(emailCheck.retryAfterSeconds) } },
    );
  }

  // Hashed unconditionally, before any existence check, and there is no
  // existence check: this goes straight to the insert attempt. Checking
  // "does this email exist" first would be a read-then-write race - two
  // concurrent requests for the same email could both see "no existing
  // user" and both proceed. It would also make the duplicate-email path
  // skip the (comparatively expensive) hash, which is a timing signal an
  // attacker could use to distinguish "taken" from "new" without needing
  // the response body to say so.
  const passwordHash = await hashPassword(password);

  let userId: string;

  try {
    const user = await prisma.user.create({
      data: { email, passwordHash, name },
    });
    userId = user.id;
  } catch (error) {
    // P2002 = unique constraint violation on User.email. Under real
    // concurrency, two requests for the same email both pass this point
    // and both attempt the insert; the database's @unique constraint is
    // what actually stops the second one, not application logic. This
    // catch only turns that rejection into the same response a first
    // success returns instead of a 500 - it must not touch the existing
    // row, so there is no update here, only a swallowed error.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // No verification code is created here - there is nothing to verify,
      // the account already exists. Instead the real owner of this address
      // is told someone tried. The response given back over HTTP is still
      // identical to the success path below; only the email differs, and
      // only the inbox that already owns this address ever sees it.
      await sendEmail({
        to: email,
        subject: "Someone tried to sign up with your email",
        body: "An attempt was made to create a new account with this email address, which already has one. If this was you, sign in normally, or use \"forgot password\" if you don't remember your password. If it wasn't you, no action is needed.",
      });
      return NextResponse.json(SUCCESS_BODY, { status: SUCCESS_STATUS });
    }
    throw error;
  }

  const verificationCode = await createVerificationCode(userId);
  await sendEmail({
    to: email,
    subject: "Verify your email",
    body: `Your verification code is ${verificationCode.code}. It expires in ${CODE_EXPIRY_MINUTES} minutes.`,
  });

  return NextResponse.json(SUCCESS_BODY, { status: SUCCESS_STATUS });
}
