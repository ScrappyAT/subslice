import { randomInt } from "crypto";
import { prisma } from "@/lib/prisma";

export const CODE_EXPIRY_MINUTES = 10;

// Math.random() is not cryptographically secure: V8 seeds it from an
// internal xorshift128+ state that can be reconstructed from a handful of
// observed outputs, and there are public tools that do exactly this. A
// six-digit code only has 1,000,000 possibilities to start with; if the
// generator itself is predictable, an attacker doesn't need to brute force
// past the resend cooldown and attempts cap - they can predict the next
// code directly. randomInt() draws from the OS's CSPRNG, which has no such
// shortcut.
function generateSixDigitCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export async function createVerificationCode(userId: string) {
  const code = generateSixDigitCode();
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);

  return prisma.verificationCode.create({
    data: { userId, code, expiresAt },
  });
}

// A six-digit code is one million possibilities - trivially brute-forceable
// with no other defence. Expiry bounds the window; this caps how many
// guesses can be spent inside that window. 5 wrong guesses is enough for a
// genuine typo or two, nowhere near enough to make a dent in 1,000,000.
export const MAX_VERIFICATION_ATTEMPTS = 5;

type VerifyCodeResult = { success: true } | { success: false };

export async function verifyCode(userId: string, submittedCode: string): Promise<VerifyCodeResult> {
  // Expiry, consumption state, and the attempts cap are all conditions on
  // the read itself, not checked afterward in application code: a code
  // that is expired, already consumed, or has used up its attempts simply
  // does not come back here, and every one of those cases is handled by
  // the same "no eligible code" branch below.
  const codeRow = await prisma.verificationCode.findFirst({
    where: {
      userId,
      consumedAt: null,
      expiresAt: { gt: new Date() },
      attempts: { lt: MAX_VERIFICATION_ATTEMPTS },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!codeRow) {
    return { success: false };
  }

  if (codeRow.code !== submittedCode) {
    // `increment` compiles to a single `UPDATE ... SET attempts = attempts
    // + 1`, not a read-modify-write from application code. That matters
    // here too: two wrong guesses arriving at the same instant both still
    // land, instead of one read-then-write clobbering the other's count
    // and quietly widening the brute-force budget.
    await prisma.verificationCode.update({
      where: { id: codeRow.id },
      data: { attempts: { increment: 1 } },
    });
    return { success: false };
  }

  // Single-use consumption via atomic conditional update - the same
  // pattern as the password reset token: updateMany with a where clause
  // that only matches a still-unconsumed, still-unexpired row, then check
  // the affected row count. Never read-then-write: if two requests both
  // reach here with the correct code before either writes, only one
  // update actually matches (consumedAt is still null at the moment it
  // runs) and returns count 1; the other matches zero rows and fails.
  const { count } = await prisma.verificationCode.updateMany({
    where: { id: codeRow.id, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });

  if (count === 0) {
    return { success: false };
  }

  await prisma.user.update({
    where: { id: userId },
    data: { emailVerifiedAt: new Date() },
  });

  return { success: true };
}

// Enough time to actually receive the previous email before another can be
// requested - not a security control by itself (rate limiting on the
// resend endpoint is the ceiling on total volume), just a minimum gap
// between sends.
export const RESEND_COOLDOWN_SECONDS = 60;

// Derived from the newest code's createdAt rather than a stored
// `lastSentAt` column - one source of truth, per the project's decision
// record. No column to keep in sync, nothing that can drift from reality.
export async function getResendCooldownRemaining(userId: string): Promise<number> {
  const newest = await prisma.verificationCode.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  if (!newest) {
    return 0;
  }

  const elapsedMs = Date.now() - newest.createdAt.getTime();
  const remainingMs = RESEND_COOLDOWN_SECONDS * 1000 - elapsedMs;

  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}
