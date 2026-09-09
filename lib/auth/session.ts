import { randomBytes, createHash } from "crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";

export const SESSION_COOKIE_NAME = "session";

// A session lives a week before it must be re-established by signing in
// again. Long enough that a returning user isn't re-prompted every day;
// short enough that a cookie nobody explicitly signed out of doesn't stay
// valid indefinitely.
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<void> {
  // The raw token is what goes in the cookie and is never written to the
  // database - only its hash is. See getSession() for why.
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await prisma.session.create({
    data: { tokenHash, userId, expiresAt },
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true, // client-side JavaScript cannot read this cookie, so an XSS payload on the page cannot exfiltrate the session token
    secure: process.env.NODE_ENV === "production", // sent only over HTTPS in production; relaxed in local dev, which has no TLS to require
    sameSite: "lax", // not attached to cross-site requests a script or form on another origin fires, blunting CSRF, while still sent on a normal top-level link click into the site
    path: "/", // readable by every route under the app (dashboard, sign out, etc.), not only the route that set it
    maxAge: SESSION_DURATION_MS / 1000, // the browser stops sending the cookie at the same moment the database would reject it anyway - the two expiries can't drift apart
  });
}

export async function getSession() {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) {
    return null;
  }

  const tokenHash = hashToken(rawToken);

  // Expiry is a condition on the lookup itself, not a check performed
  // afterward - an expired row simply doesn't come back, the same pattern
  // used for verification codes and (later) reset tokens.
  return prisma.session.findFirst({
    where: { tokenHash, expiresAt: { gt: new Date() } },
    include: { user: true },
  });
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (rawToken) {
    const tokenHash = hashToken(rawToken);
    await prisma.session.deleteMany({ where: { tokenHash } });
  }

  cookieStore.delete(SESSION_COOKIE_NAME);
}

// The real gate. This does a database lookup on every call - middleware
// running on the edge runtime cannot do this (Prisma does not run there
// without an adapter this project doesn't use), so it could only ever
// check whether a session cookie is present, not whether the session
// behind it is still valid. This is why the check happens here, in a
// Server Component / Route Handler, where Prisma works normally.
export async function requireSession() {
  const session = await getSession();
  if (!session) {
    redirect("/signin");
  }
  return session.user;
}
