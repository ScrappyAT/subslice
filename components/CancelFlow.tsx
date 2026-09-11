"use client";

import { useState } from "react";
import Link from "next/link";

interface CancelFlowProps {
  planCode: string;
  periodEnd: string; // ISO string — Date isn't serialisable across the server/client boundary
}

type Step =
  | { name: "confirming" }
  | { name: "cancelled"; periodEnd: string }
  | { name: "reason-prompt"; periodEnd: string }
  | { name: "done" };

/**
 * The interactive half of /cancel: everything up to and including this
 * component's initial render came from previewCancellation (a GET, writes
 * nothing). Confirming is the one explicit POST that writes
 * CANCELLATION_REQUESTED; the reason prompt after it is a second, optional
 * POST, skippable — skipping calls nothing at all (lib/cancellation.ts's
 * own doc: "skipping simply means this is never called").
 */
export default function CancelFlow({ planCode, periodEnd }: CancelFlowProps) {
  const [step, setStep] = useState<Step>({ name: "confirming" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reason, setReason] = useState("");

  async function confirmCancellation() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/cancel/confirm", { method: "POST" });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // "already_cancelled" is not a failure to explain away as an
        // error — it means there is already nothing left to do here.
        if (response.status === 400 && body?.periodEnd) {
          setStep({ name: "cancelled", periodEnd: body.periodEnd });
          return;
        }
        setError(body?.error ?? "Something went wrong. Please try again.");
        return;
      }
      setStep({ name: "reason-prompt", periodEnd: body.periodEnd });
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitReason() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/cancel/reason", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(body?.error ?? "Something went wrong. Please try again.");
        return;
      }
      setStep({ name: "done" });
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (step.name === "confirming") {
    return (
      <div className="mt-6 flex flex-col gap-4">
        <p className="text-sm text-gray-700">
          You&apos;ll keep access to the <span className="capitalize">{planCode}</span> plan until{" "}
          {new Date(periodEnd).toLocaleDateString("en-GB", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" })}
          . After that, your subscription ends — this is not an immediate cutoff.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={confirmCancellation}
            disabled={submitting}
            className="rounded-md bg-red-700 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {submitting ? "Cancelling…" : "Cancel subscription"}
          </button>
          <Link href="/billing" className="rounded-md border border-gray-400 px-4 py-2 text-sm">
            Never mind
          </Link>
        </div>
      </div>
    );
  }

  if (step.name === "cancelled") {
    return (
      <div className="mt-6">
        <p className="text-sm text-gray-700">
          Your subscription is already set to cancel. Access continues until{" "}
          {new Date(step.periodEnd).toLocaleDateString("en-GB", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" })}
          .
        </p>
        <Link href="/billing" className="mt-4 inline-block text-sm underline">
          Back to billing
        </Link>
      </div>
    );
  }

  if (step.name === "reason-prompt") {
    return (
      <div className="mt-6 flex flex-col gap-4">
        <p className="text-sm text-gray-700">
          Cancellation confirmed. Access continues until{" "}
          {new Date(step.periodEnd).toLocaleDateString("en-GB", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" })}
          .
        </p>
        <label htmlFor="cancel-reason" className="text-sm font-medium">
          Would you mind telling us why? (optional)
        </label>
        <textarea
          id="cancel-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          rows={3}
          className="rounded-md border border-gray-400 p-2 text-sm"
        />
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={submitReason}
            disabled={submitting || reason.trim().length === 0}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {submitting ? "Submitting…" : "Submit"}
          </button>
          <Link href="/billing" className="rounded-md border border-gray-400 px-4 py-2 text-sm">
            Skip
          </Link>
        </div>
      </div>
    );
  }

  // step.name === "done"
  return (
    <div className="mt-6">
      <p className="text-sm text-gray-700">Thanks for letting us know.</p>
      <Link href="/billing" className="mt-4 inline-block text-sm underline">
        Back to billing
      </Link>
    </div>
  );
}
