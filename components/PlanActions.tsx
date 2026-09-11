"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatForDisplay } from "@/lib/money";
import type { PlanCode } from "@/lib/plans";

interface PlanActionsProps {
  /** The render-time projection (lib/currentEntitlement.ts's
   * effectivePlanForDisplay) — "free" for both a genuinely new user and a
   * lapsed one, which is exactly why both get the same subscribe controls
   * below without this component needing to tell them apart. */
  effectivePlan: PlanCode;
  cancelAtPeriodEnd: boolean;
  pendingPlanCode: PlanCode | null;
  periodEndIso: string | null;
}

type QuoteState =
  | { phase: "idle" }
  | {
      phase: "quoted";
      txRef: string;
      daysInPeriod: number;
      daysRemaining: number;
      creditMinor: number;
      chargeMinor: number;
      currency: string;
    };

/**
 * Wires the plans view to the endpoints step 6, 9 and 10 already built —
 * no new endpoint, no new domain logic, no reactivate control (the brief's
 * own list of what not to build here). One control per current state,
 * exactly the mapping given in the report:
 *
 * - free or lapsed  -> POST /api/checkout                (subscribe)
 * - active monthly  -> POST /api/upgrade/quote,
 *                      then POST /api/upgrade/confirm     (upgrade, quoted first)
 * - active yearly   -> POST /api/downgrade                (downgrade)
 * - pending downgrade -> POST /api/downgrade/cancel        (cancel the schedule)
 * - cancelling      -> no controls, just says why
 */
export default function PlanActions({ effectivePlan, cancelAtPeriodEnd, pendingPlanCode, periodEndIso }: PlanActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<QuoteState>({ phase: "idle" });

  async function subscribe(planCode: "monthly" | "yearly") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planCode }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(body?.error ?? "Something went wrong. Please try again.");
        return;
      }
      window.location.href = body.checkoutUrl;
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function requestUpgradeQuote() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/upgrade/quote", { method: "POST" });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(body?.error ?? "Could not get a quote. Please try again.");
        return;
      }
      setQuote({ phase: "quoted", ...body });
    } catch {
      setError("Could not get a quote. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmUpgrade() {
    if (quote.phase !== "quoted") return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/upgrade/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txRef: quote.txRef }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(response.status === 401 ? "session_expired" : (body?.error ?? "Could not confirm the upgrade. Please try again."));
        return;
      }
      window.location.href = body.checkoutUrl;
    } catch {
      setError("Could not confirm the upgrade. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function downgrade() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/downgrade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetPlanCode: "monthly" }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(response.status === 401 ? "session_expired" : (body?.error ?? "Could not schedule the downgrade. Please try again."));
        return;
      }
      router.refresh();
    } catch {
      setError("Could not schedule the downgrade. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function cancelScheduledDowngrade() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/downgrade/cancel", { method: "POST" });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(body?.error ?? "Could not cancel the scheduled downgrade. Please try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not cancel the scheduled downgrade. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // Step 13 close-out, item 4: session-expired at upgrade confirm and
  // downgrade keeps this same inline error, with a sign-in link added —
  // no redirect logic, just something to click.
  const errorBlock = error ? (
    <p role="alert" className="mt-3 text-sm text-red-600">
      {error === "session_expired" ? (
        <>
          Your session has expired. <Link href="/signin" className="underline">Sign in again</Link>.
        </>
      ) : (
        error
      )}
    </p>
  ) : null;

  // Cancelled with access remaining: no plan-change controls at all, and
  // say why — a downgrade or upgrade during the cancelling grace period
  // would contradict the decision to leave (see lib/cancellation.ts's own
  // "last action wins" reasoning), so this isn't offered as a dead end,
  // it's explained as not applicable.
  if (cancelAtPeriodEnd) {
    return (
      <div className="mt-6 rounded-md border border-gray-300 p-4 text-sm text-gray-700">
        Your subscription is set to cancel. Changing plans isn&apos;t available while cancelling — undo the
        cancellation from Billing first if you want to switch plans instead.
      </div>
    );
  }

  // A downgrade is already scheduled: show it, offer only to cancel it.
  if (pendingPlanCode) {
    return (
      <div className="mt-6 rounded-md border border-gray-300 p-4 text-sm">
        <p>
          Switching to <span className="capitalize">{pendingPlanCode}</span> on{" "}
          {periodEndIso
            ? new Date(periodEndIso).toLocaleDateString("en-GB", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" })
            : "the next renewal"}
          .
        </p>
        <button
          type="button"
          onClick={cancelScheduledDowngrade}
          disabled={busy}
          className="mt-3 rounded-md border border-gray-400 px-4 py-2 disabled:opacity-50"
        >
          {busy ? "Cancelling…" : "Cancel scheduled downgrade"}
        </button>
        {errorBlock}
      </div>
    );
  }

  if (effectivePlan === "free") {
    return (
      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={() => subscribe("monthly")}
          disabled={busy}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          Subscribe to Monthly
        </button>
        <button
          type="button"
          onClick={() => subscribe("yearly")}
          disabled={busy}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          Subscribe to Yearly
        </button>
        {errorBlock}
      </div>
    );
  }

  if (effectivePlan === "monthly") {
    if (quote.phase === "quoted") {
      return (
        <div className="mt-6 rounded-md border border-gray-300 p-4 text-sm">
          <p>
            {quote.daysRemaining} of {quote.daysInPeriod} days remain on your current period.
          </p>
          <p className="mt-1">Credit for unused time: {formatForDisplay(quote.creditMinor, quote.currency)}</p>
          <p className="mt-1 font-medium">Charge today: {formatForDisplay(quote.chargeMinor, quote.currency)}</p>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              onClick={confirmUpgrade}
              disabled={busy}
              className="rounded-md bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
            >
              {busy ? "Confirming…" : "Confirm upgrade"}
            </button>
            <button
              type="button"
              onClick={() => setQuote({ phase: "idle" })}
              disabled={busy}
              className="rounded-md border border-gray-400 px-4 py-2"
            >
              Cancel
            </button>
          </div>
          {errorBlock}
        </div>
      );
    }
    return (
      <div className="mt-6">
        <button
          type="button"
          onClick={requestUpgradeQuote}
          disabled={busy}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {busy ? "Loading…" : "Upgrade to Yearly"}
        </button>
        {errorBlock}
      </div>
    );
  }

  // effectivePlan === "yearly"
  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={downgrade}
        disabled={busy}
        className="rounded-md border border-gray-400 px-4 py-2 text-sm disabled:opacity-50"
      >
        {busy ? "Scheduling…" : "Downgrade to Monthly"}
      </button>
      {errorBlock}
    </div>
  );
}
