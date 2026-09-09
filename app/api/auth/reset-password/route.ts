import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resetPasswordSchema } from "@/lib/validation/schemas";
import { consumeResetToken } from "@/lib/auth/tokens";
import { hashPassword } from "@/lib/auth/password";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = resetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { token, password } = parsed.data;

  // Consumed before the (expensive) password hash is computed - an
  // invalid or expired token is rejected cheaply, rather than spending a
  // ~600ms bcrypt hash on a request that was never going anywhere.
  const result = await consumeResetToken(token);
  if (!result) {
    return NextResponse.json({ error: "Invalid or expired reset link" }, { status: 400 });
  }

  const passwordHash = await hashPassword(password);

  await prisma.user.update({
    where: { id: result.userId },
    data: { passwordHash },
  });

  // A password reset is exactly the moment an attacker holding a stolen
  // session needs to be cut off. If someone else's session survived this,
  // resetting the password would not have actually locked them out.
  await prisma.session.deleteMany({ where: { userId: result.userId } });

  return NextResponse.json({ message: "Password has been reset." }, { status: 200 });
}
