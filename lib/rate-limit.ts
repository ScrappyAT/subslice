import { prisma } from "@/lib/prisma";

// Limits per protected endpoint, defined once here rather than scattered
// as magic numbers across route files. Each key is checked twice per
// request - once for the caller's IP, once for the submitted email - using
// the same limit/window pair; see the routes for how the two keys are
// namespaced apart from each other.
export const RATE_LIMITS = {
  // Brute-forcing a password already costs ~600ms per guess against
  // bcrypt cost 12. 10 attempts per 15 minutes is generous for a genuine
  // user who mistypes a password a few times, while still capping any
  // single account or IP to a rate nowhere near enough to make a dent in
  // a reasonable password's keyspace within the window.
  signin: { limit: 10, windowSeconds: 15 * 60 },

  // A real signup is a one-time action per person. 5 per hour per
  // IP/email absorbs retries (network hiccup, typo'd password
  // confirmation elsewhere) while blocking scripted mass account
  // creation, which is the actual threat here.
  signup: { limit: 5, windowSeconds: 60 * 60 },

  // Each request sends an email to whatever address is submitted -
  // including addresses the requester doesn't own. Without a limit, this
  // endpoint is a free tool for mail-bombing someone else's inbox with
  // reset links they never asked for. 5 per hour per IP/email caps that
  // exposure while still covering a genuine user who forgot, tried again,
  // and mistyped once.
  forgotPassword: { limit: 5, windowSeconds: 60 * 60 },

  // The brief calls this one out by name: it is the endpoint that costs
  // real money once a real email provider is behind sendEmail(). It
  // already has its own 60-second cooldown (lib/auth/codes.ts) enforcing
  // a minimum gap between sends, but that alone still allows up to ~60
  // sends an hour if hammered exactly on the cooldown boundary. 3 per
  // hour per IP/email is the hard ceiling on top of that: three genuine
  // resends covers anyone actually waiting on a real code, and bounds
  // worst-case cost even if the cooldown were somehow bypassed.
  verifyResend: { limit: 3, windowSeconds: 60 * 60 },
} as const;

interface RateLimitResult {
  allowed: boolean;
  // Only meaningful when allowed is false - seconds until the oldest hit
  // still inside this key's window ages out and there is room again.
  retryAfterSeconds: number;
}

export async function checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const windowStart = new Date(Date.now() - windowSeconds * 1000);

  // Prune this key's history older than the window before counting, so a
  // key that has gone quiet doesn't carry rows forever - the table stays
  // bounded per key without a separate cleanup job.
  await prisma.rateLimitHit.deleteMany({ where: { key, createdAt: { lt: windowStart } } });

  const count = await prisma.rateLimitHit.count({ where: { key } });

  if (count >= limit) {
    const oldest = await prisma.rateLimitHit.findFirst({
      where: { key },
      orderBy: { createdAt: "asc" },
    });
    const retryAfterMs = oldest
      ? oldest.createdAt.getTime() + windowSeconds * 1000 - Date.now()
      : windowSeconds * 1000;

    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  // Only a request that is actually allowed becomes a hit. If a rejected
  // request also inserted a row, an attacker (or just an impatient user)
  // retrying nonstop while blocked would keep pushing "most recent hit"
  // forward and might never see the count drop back below the limit -
  // effectively an indefinite lockout for retrying at all, not a bounded
  // one.
  await prisma.rateLimitHit.create({ data: { key } });

  return { allowed: true, retryAfterSeconds: 0 };
}

// Behind a real reverse proxy (Vercel, nginx, etc.) this header is set
// reliably by the proxy, not the client, so it can't simply be spoofed by
// whoever is sending the request. In raw local dev with no proxy in
// front, it is absent and every request collapses to "unknown" - which
// still functions, just as a single shared IP-bucket for local testing.
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }
  return "unknown";
}
