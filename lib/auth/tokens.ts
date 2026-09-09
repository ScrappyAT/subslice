import { randomBytes, createHash } from "crypto";
import { prisma } from "@/lib/prisma";

// Deliberately much shorter than a session (7 days). A reset link sits in
// an inbox, often an inbox other people or other devices can also reach,
// for as short a time as still lets a real user click it. 30 minutes is
// long enough to open the email and act on it, short enough that a link
// forgotten in an old email isn't a live credential weeks later.
export const RESET_TOKEN_EXPIRY_MINUTES = 30;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createResetToken(userId: string): Promise<string> {
  // Same shape as a session token: 32 random bytes, only the hash stored.
  // The raw value exists only in the email link and the requester's
  // browser - a leaked PasswordResetToken table row is useless on its own.
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MINUTES * 60 * 1000);

  await prisma.passwordResetToken.create({
    data: { tokenHash, userId, expiresAt },
  });

  return rawToken;
}

export async function consumeResetToken(rawToken: string): Promise<{ userId: string } | null> {
  const tokenHash = hashToken(rawToken);

  // Read first to find the eligible row and its userId - expiry and
  // consumption state are conditions on this read, not checked afterward.
  const tokenRow = await prisma.passwordResetToken.findFirst({
    where: { tokenHash, consumedAt: null, expiresAt: { gt: new Date() } },
  });

  if (!tokenRow) {
    return null;
  }

  // Then consume with an atomic conditional update, never trusting the
  // read alone: two requests racing to use the same link both pass the
  // read above, but only one updateMany actually matches a still-unconsumed
  // row (consumedAt is still null at the instant it runs) and gets count 1
  // back. The other gets count 0 and is rejected, even though it also saw
  // a "valid" token a moment earlier.
  const { count } = await prisma.passwordResetToken.updateMany({
    where: { id: tokenRow.id, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });

  if (count === 0) {
    return null;
  }

  return { userId: tokenRow.userId };
}
