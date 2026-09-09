"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import Field from "@/components/Field";
import { resetRequestSchema } from "@/lib/validation/schemas";

function firstMessages(fieldErrors: Record<string, string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [field, messages] of Object.entries(fieldErrors)) {
    if (messages?.[0]) {
      result[field] = messages[0];
    }
  }
  return result;
}

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmationMessage, setConfirmationMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const parsed = resetRequestSchema.safeParse({ email });
    if (!parsed.success) {
      setFieldErrors(firstMessages(parsed.error.flatten().fieldErrors));
      return;
    }
    setFieldErrors({});
    setSubmitting(true);

    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        setFormError(
          retryAfter
            ? `Too many attempts. Try again in ${retryAfter} seconds.`
            : "Too many attempts. Try again later.",
        );
        return;
      }

      const body = await response.json().catch(() => null);

      if (!response.ok) {
        setFormError(body?.error ?? "Something went wrong. Please try again.");
        if (body?.fieldErrors) {
          setFieldErrors(firstMessages(body.fieldErrors));
        }
        return;
      }

      // Displayed verbatim, not reworded: the server returns this exact
      // message whether or not the email has an account, so nothing added
      // on top of it could accidentally leak what the server deliberately
      // does not reveal.
      setConfirmationMessage(body?.message ?? "If that email has an account, a reset link has been sent.");
    } catch {
      setFormError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (confirmationMessage) {
    return (
      <main className="mx-auto flex max-w-sm flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold">Forgot password</h1>
        <p className="text-sm">{confirmationMessage}</p>
        <p className="text-sm">
          <Link href="/signin" className="underline">
            Back to sign in
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">Forgot password</h1>
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={fieldErrors.email}
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
          {submitting ? "Sending…" : "Send reset link"}
        </button>
      </form>
      <p className="text-sm">
        <Link href="/signin" className="underline">
          Back to sign in
        </Link>
      </p>
    </main>
  );
}
