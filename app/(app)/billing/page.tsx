import Link from "next/link";
import { requireSession } from "@/lib/auth/session";
import { getCurrentEntitlement } from "@/lib/currentEntitlement";
import { formatDate } from "@/lib/formatDate";

/**
 * Plan, status, renewal date, cancel control — display only, plus a link
 * into the existing cancellation flow (step 11's endpoints, step 12's
 * /cancel page). Nothing here reads Subscription; every fact comes from
 * deriveEntitlement via lib/currentEntitlement.ts.
 */
export default async function BillingPage() {
  const user = await requireSession();
  const entitlement = await getCurrentEntitlement(user.id, new Date());

  if (entitlement.status === "inconsistent") {
    // No plan name, no controls — InconsistentLog carries no planCode by
    // design (Step 11 follow-up 2, item 8), so there is nothing here to
    // read even if this branch were tempted to.
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="mt-4 text-red-700">We cannot determine your plan right now.</p>
      </div>
    );
  }

  // A genuine empty state (hard rule 7): nobody has ever paid. planCode is
  // "free" and periodEnd is null together, always (EntitlementState's own
  // contract) — this is not "an active free plan", it is "no history".
  if (entitlement.periodEnd === null) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="mt-4 text-gray-700">You don&apos;t have a subscription yet.</p>
        <Link href="/plans" className="mt-2 inline-block text-sm underline">
          View plans
        </Link>
      </div>
    );
  }

  const { planCode, periodEnd, accessGranted, cancelAtPeriodEnd, pendingPlanCode } = entitlement;

  // Renewal date vs. access-ends date: the same periodEnd column means two
  // different things depending on cancelAtPeriodEnd, and must be labelled
  // accordingly, not just printed under a fixed "Renews" heading.
  const statusLabel = !accessGranted ? "Expired" : cancelAtPeriodEnd ? "Cancelling" : "Active";
  const dateLabel = !accessGranted ? "Access ended" : cancelAtPeriodEnd ? "Access ends" : "Renews";

  // Nothing meaningful to cancel once access is already gone or the
  // cancellation is already in effect — requestCancellation would only
  // report "no_active_paid_plan" or "already_cancelled" either way.
  const showCancelLink = accessGranted && !cancelAtPeriodEnd;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold">Billing</h1>

      <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="font-medium text-gray-600">Plan</dt>
        <dd className="capitalize">{planCode}</dd>

        <dt className="font-medium text-gray-600">Status</dt>
        <dd>{statusLabel}</dd>

        <dt className="font-medium text-gray-600">{dateLabel}</dt>
        <dd>{formatDate(periodEnd)}</dd>

        {pendingPlanCode ? (
          <>
            <dt className="font-medium text-gray-600">Scheduled change</dt>
            <dd>
              Moving to <span className="capitalize">{pendingPlanCode}</span> on {formatDate(periodEnd)}.
            </dd>
          </>
        ) : null}
      </dl>

      {cancelAtPeriodEnd ? (
        <p className="mt-6 text-sm text-gray-700">
          Your subscription is set to end on {formatDate(periodEnd)}. Access continues until then.
        </p>
      ) : null}

      {showCancelLink ? (
        <Link href="/cancel" className="mt-6 inline-block text-sm text-red-700 underline">
          Cancel subscription
        </Link>
      ) : null}
    </div>
  );
}
