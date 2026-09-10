import type { SubscriptionStatus } from "@prisma/client";
import { prisma } from "./prisma";
import { deriveEntitlement } from "./entitlement";

/**
 * Recomputes and upserts the Subscription row for one user from their event
 * log. This is a CACHE, never a source of truth — AGENTS.md: "Subscription
 * columns are for display only. No code path may read Subscription.status,
 * cancelAtPeriodEnd, planCode or the period columns to make an entitlement
 * decision." Every access decision goes through deriveEntitlement directly;
 * this exists only so a cheap read (a billing page, or the brief's
 * before/after screenshot) has something to show without replaying the
 * whole log on every request. Call it after any event append that could
 * change what deriveEntitlement returns — a fresh ENTITLEMENT_GRANTED, a
 * scheduled downgrade, a cancellation, or its reason. Nothing else moves
 * entitlement (see lib/entitlement.ts), so nothing else needs to call this.
 *
 * `now` is a parameter, not `new Date()` inside, for the same reason as
 * everywhere else this codebase derives entitlement: deriveEntitlement
 * needs a reference point, and a test needs to control what it is.
 */
export async function refreshSubscriptionProjection(userId: string, now: Date): Promise<void> {
  const events = await prisma.paymentEvent.findMany({
    where: { userId },
    orderBy: { seq: "asc" },
  });

  const entitlement = deriveEntitlement(events, now);

  if (entitlement.status === "inconsistent") {
    // Nothing coherent to cache. The event log is still the source of
    // truth regardless — logged for investigation, and whatever
    // Subscription row already exists (if any) is left exactly as it was
    // rather than overwritten with a guess.
    console.error("Cannot refresh Subscription projection: log is inconsistent", {
      userId,
      reason: entitlement.reason,
      atSeq: entitlement.atSeq,
    });
    return;
  }

  if (entitlement.periodStart === null || entitlement.periodEnd === null) {
    // Nobody has ever paid (planCode is "free" and always has been —
    // EntitlementState's own contract). currentPeriodStart/currentPeriodEnd
    // are non-null columns on Subscription; there is no period to cache
    // for a user with no history, so there is nothing to write yet.
    return;
  }

  const status: SubscriptionStatus = !entitlement.accessGranted
    ? "EXPIRED"
    : entitlement.cancelAtPeriodEnd
      ? "CANCELLING"
      : "ACTIVE";

  const lastEventSeq = events.length > 0 ? events[events.length - 1].seq : null;

  // deriveEntitlement exposes *that* a cancellation is pending, not *when*
  // it was requested — that timestamp is read off the log event directly,
  // the most recent CANCELLATION_REQUESTED if one is currently in effect.
  const cancelledAt = entitlement.cancelAtPeriodEnd
    ? (events.filter((e) => e.type === "CANCELLATION_REQUESTED").at(-1)?.createdAt ?? null)
    : null;

  const projection = {
    planCode: entitlement.planCode,
    status,
    currentPeriodStart: entitlement.periodStart,
    currentPeriodEnd: entitlement.periodEnd,
    cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd,
    cancelledAt,
    cancellationReason: entitlement.cancellationReason,
    pendingPlanCode: entitlement.pendingPlanCode,
    lastEventSeq,
  };

  await prisma.subscription.upsert({
    where: { userId },
    create: { userId, ...projection },
    update: projection,
  });
}
