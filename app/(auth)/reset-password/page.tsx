"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Field from "@/components/Field";
import { resetPasswordSchema } from "@/lib/validation/schemas";

function firstMessages(fieldErrors: Record<string, string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [field, messages] of Object.entries(fieldErrors)) {
    if (messages?.[0]) {
      result[field] = messages[0];
    }
  }
  return result;
}

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const parsed = resetPasswordSchema.safeParse({ token, password });
    if (!parsed.success) {
      setFieldErrors(firstMessages(parsed.error.flatten().fieldErrors));
      return;
    }
    setFieldErrors({});
    setSubmitting(true);

    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      // No 429 branch: /api/auth/reset-password has no rate limit of its
      // own - the token itself is the guard (single use, 30-minute expiry,
      // unguessable), and the "reset REQUEST" endpoint one step earlier is
      // where rate limiting actually applies.
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        setFormError(body?.error ?? "Something went wrong. Please try again.");
        if (body?.fieldErrors) {
          setFieldErrors(firstMessages(body.fieldErrors));
        }
        return;
      }

      // No session is created by this endpoint (it deletes sessions, it
      // doesn't start one) - the next step is a real signin with the new
      // password, not a bounce to a dashboard the user has no session for.
      router.push("/signin");
    } catch {
      setFormError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">Reset password</h1>
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <Field
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={fieldErrors.password}
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
          {submitting ? "Resetting…" : "Reset password"}
        </button>
      </form>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
