import { prisma } from "./prisma";
import { deriveEntitlement, type Entitlement, type EntitlementState } from "./entitlement";
import type { PlanCode } from "./plans";

/**
 * The one place every page in the signed-in shell (app/(app)) gets a
 * user's entitlement from: fetch the log, replay it. AGENTS.md:
 * "No code path may read Subscription.status, cancelAtPeriodEnd, planCode
 * or the period columns to make an entitlement decision" — the same rule
 * a page rendering those facts falls under, so nothing under app/(app)
 * ever queries `prisma.subscription`. Duplicated (fetch + derive) inline
 * in lib/cancellation.ts and lib/downgrade.ts already; extracted here only
 * because three view pages would otherwise repeat the same five lines,
 * not because the logic itself is new.
 */
export async function getCurrentEntitlement(userId: string, now: Date): Promise<Entitlement> {
  const events = await prisma.paymentEvent.findMany({
    where: { userId },
    orderBy: { seq: "asc" },
  });
  return deriveEntitlement(events, now);
}

/**
 * The render-time-only projection: what plan a user should be SHOWN as
 * being on right now, as opposed to what deriveEntitlement's own planCode
 * says. planCode never resets to "free" on its own — it stays the last
 * plan actually paid for, deliberately, so the true history is never lost
 * (AGENTS.md: "still on record — only access lapses"; confirmed in the
 * Step 11 follow-up rounds). A lapsed yearly subscriber is not "on the
 * free plan" as a historical fact, but for the one purpose of "which plan
 * card gets the current-plan badge", they have no more access than a free
 * user does, and this is the single place that distinction is made — no
 * other page reimplements it or reads planCode directly for this purpose.
 */
export function effectivePlanForDisplay(entitlement: EntitlementState): PlanCode {
  return entitlement.accessGranted ? entitlement.planCode : "free";
}
