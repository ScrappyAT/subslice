import { requireSession } from "@/lib/auth/session";
import { listActivePlans } from "@/lib/plans";
import { getCurrentEntitlement, effectivePlanForDisplay } from "@/lib/currentEntitlement";
import { formatForDisplay } from "@/lib/money";
import { formatDate } from "@/lib/formatDate";

/**
 * Free, monthly, yearly, current plan indicated. Display only — this step
 * does not add a plan-change flow beyond the existing upgrade and
 * downgrade endpoints (the brief's own "do not build" line), and nothing
 * here asked for subscribe/upgrade/downgrade controls specifically, only
 * for the current plan to be indicated correctly. See the report for why
 * that scoping was chosen deliberately rather than assumed.
 *
 * Everything below comes from deriveEntitlement (via
 * lib/currentEntitlement.ts) — nothing reads Subscription.
 */
export default async function PlansPage() {
  const user = await requireSession();
  const [plans, entitlement] = await Promise.all([
    listActivePlans(),
    getCurrentEntitlement(user.id, new Date()),
  ]);

  if (entitlement.status === "inconsistent") {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="text-2xl font-semibold">Plans</h1>
        <p className="mt-4 text-red-700">We cannot determine your plan right now.</p>
      </div>
    );
  }

  // The render-time projection (Step 12, item 2): what the current-plan
  // badge shows is not entitlement.planCode directly. Put here, and only
  // here — lib/currentEntitlement.ts's effectivePlanForDisplay.
  const currentPlan = effectivePlanForDisplay(entitlement);
  const lapsed = !entitlement.accessGranted && entitlement.planCode !== "free";

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold">Plans</h1>

      {lapsed && entitlement.periodEnd ? (
        <p className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          You were on the {entitlement.planCode} plan. Access lapsed on {formatDate(entitlement.periodEnd)}.
        </p>
      ) : null}

      <ul className="mt-6 flex flex-col gap-4 sm:flex-row">
        {plans.map((plan) => (
          <li key={plan.code} className="flex-1 rounded-md border border-gray-300 p-4">
            <h2 className="text-lg font-semibold">
              {plan.name}
              {plan.code === currentPlan ? (
                <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                  Current plan
                </span>
              ) : null}
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              {plan.interval === "NONE"
                ? "Free"
                : `${formatForDisplay(plan.amountMinor, plan.currency)} / ${plan.interval === "MONTH" ? "month" : "year"}`}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
