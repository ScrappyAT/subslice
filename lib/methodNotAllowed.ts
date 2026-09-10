import { NextResponse } from "next/server";

/**
 * The response for a request that reaches a route on a method it exports no
 * handler for — a browser GET on a POST-only mutating endpoint, in every
 * case this is used. AGENTS.md's own bar ("tell me what happens if I reach
 * that code path directly in my browser") is not met by Next.js App
 * Router's bare default for an unlisted method: a 405 with an empty body
 * and no Allow header. That default leaves nothing for a person to read and
 * nothing for a client to act on, so every mutating route in the payment
 * path gets an explicit GET handler that calls this instead of leaving the
 * method unhandled.
 *
 * `allowed` is the exact set of methods this route does export, used both
 * for the Allow header (RFC 9110 §10.2.1 — required on a 405) and the
 * message body.
 */
export function methodNotAllowed(allowed: string[]): NextResponse {
  return NextResponse.json(
    {
      error: `This endpoint only accepts ${allowed.join(", ")}. It changes account state and is meant to be called by this app, not visited directly.`,
    },
    { status: 405, headers: { Allow: allowed.join(", ") } },
  );
}
