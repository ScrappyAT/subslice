"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Field from "@/components/Field";
import { verifyCodeSchema } from "@/lib/validation/schemas";

// Mirrors lib/auth/codes.ts's RESEND_COOLDOWN_SECONDS. Duplicated rather
// than imported: that file pulls in the Prisma client, which cannot be
// bundled into client-side JavaScript. This number only drives a cosmetic
// countdown here - it is never the thing actually enforcing the cooldown,
// see the note on handleResend below.
const RESEND_COOLDOWN_SECONDS = 60;

function firstMessages(fieldErrors: Record<string, string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [field, messages] of Object.entries(fieldErrors)) {
    if (messages?.[0]) {
      result[field] = messages[0];
    }
  }
  return result;
}

function VerifyForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = searchParams.get("email") ?? "";

  const [code, setCode] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // A code is sent the moment this page is reached - by the signup that
  // redirected here, or by a resend click below - so the cooldown starts
  // counting down from page load.
  const [cooldownUntil, setCooldownUntil] = useState(() => Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
  const [now, setNow] = useState(() => Date.now());
  const [resending, setResending] = useState(false);
  const [resendMessage, setResendMessage] = useState<string | null>(null);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const cooldownRemaining = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const parsed = verifyCodeSchema.safeParse({ email, code });
    if (!parsed.success) {
      setFieldErrors(firstMessages(parsed.error.flatten().fieldErrors));
      return;
    }
    setFieldErrors({});
    setSubmitting(true);

    try {
      const response = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      // No 429 branch here: /api/auth/verify has no rate limit of its own
      // (brute force is bounded by the attempts cap on the code itself,
      // not by request volume) - unlike resend below, which does.
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        setFormError(body?.error ?? "Something went wrong. Please try again.");
        return;
      }

      router.push("/dashboard");
    } catch {
      setFormError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend() {
    setResendMessage(null);
    setResending(true);

    try {
      const response = await fetch("/api/auth/verify/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        setResendMessage(
          retryAfter
            ? `Too many attempts. Try again in ${retryAfter} seconds.`
            : "Too many attempts. Try again later.",
        );
        return;
      }

      // The server's response is identical whether a code was actually
      // sent or the request silently did nothing (no such account,
      // already verified, or still inside the server's own cooldown) - by
      // design, so this page cannot and does not try to tell those apart.
      // Restarting the local countdown here is optimistic, not a claim
      // that a code was definitely (re)sent.
      const body = await response.json().catch(() => null);
      setResendMessage(body?.message ?? "If that email has an unverified account, a new code has been sent.");
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
    } catch {
      setResendMessage("Something went wrong. Please try again.");
    } finally {
      setResending(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">Verify your email</h1>
      <p className="text-sm">Enter the 6-digit code sent to {email || "your email"}.</p>
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <Field
          label="Verification code"
          name="code"
          type="text"
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          error={fieldErrors.code}
        />
        {formError ? (
          <p role="alert" className="text-sm text-red-600">
            {formError}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          {submitting ? "Verifying…" : "Verify"}
        </button>
      </form>
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={handleResend}
          disabled={resending || cooldownRemaining > 0}
          className="text-left text-sm underline disabled:text-gray-400 disabled:no-underline"
        >
          {cooldownRemaining > 0 ? `Resend code in ${cooldownRemaining}s` : "Resend code"}
        </button>
        {resendMessage ? <p className="text-sm">{resendMessage}</p> : null}
      </div>
    </main>
  );
}

export default function VerifyPage() {
  return (
    <Suspense>
      <VerifyForm />
    </Suspense>
  );
}
