import { prisma } from "./prisma";
import { deriveEntitlement } from "./entitlement";
import { appendPaymentEvent } from "./paymentLog";
import { refreshSubscriptionProjection } from "./subscriptionProjection";

export type ScheduleDowngradeResult =
  | { outcome: "scheduled"; currentPlanCode: string; targetPlanCode: string; effectiveAt: Date }
  | { outcome: "same_plan" }
  /** The target costs the same or more — that is an upgrade, which goes
   * through the proration path (lib/upgradeQuote.ts), not this one. */
  | { outcome: "would_be_upgrade" }
  | { outcome: "no_active_paid_plan" }
  | { outcome: "invalid_target" }
  /** The free plan is never a downgrade target — leaving a paid plan
   * entirely is cancellation's job (a separate, later step), not a
   * "downgrade" to nothing. */
  | { outcome: "target_is_free" }
  | { outcome: "inconsistent" };

export type CancelDowngradeResult =
  | { outcome: "cancelled"; planCode: string }
  | { outcome: "no_pending_downgrade" }
  | { outcome: "inconsistent" };

/**
 * Cancelling a scheduled downgrade, and the idempotency key question
 * (step 10):
 *
 * CHOSEN: reuse DOWNGRADE_SCHEDULED itself — no new event type. Cancelling
 * is scheduling "back to" the plan already in effect: deriveEntitlement
 * already replays the *latest* DOWNGRADE_SCHEDULED as the pending plan
 * (see lib/entitlement.ts), so a DOWNGRADE_SCHEDULED naming the current
 * plan means "nothing changes at the boundary" — a correct, honest
 * representation of "cancelled" using a decision already fully built,
 * rather than a new enum value PaymentEventType doesn't have and adding
 * one would need a migration this step doesn't call for.
 *
 * REJECTED: a distinct event type (e.g. a hypothetical
 * DOWNGRADE_CANCELLED). Works, but changes the schema for one step when
 * the existing type already says everything needed once its target is
 * "the plan you're already on".
 *
 * Does `downgrade:{userId}:{currentPeriodEnd ISO}` still hold for
 * schedule -> cancel -> reschedule within one period? NO, not literally.
 * That key is invariant for the whole period, so a second write with the
 * bare formula collides with the first and is silently swallowed — for a
 * *different* decision, not a retry of the same one. That is exactly the
 * failure the idempotency-key table exists to prevent, not cause. So:
 * the bare AGENTS.md formula is used for the first schedule in a period
 * (satisfying it exactly for the common case), and any action taken while
 * a downgrade is *already* pending — cancelling, or changing the target —
 * appends the moment it happened, guaranteeing its own row. An exact
 * duplicate submission of the same click still collides (same
 * millisecond is not realistic for a second human decision); a genuine
 * change of mind, any number of times, never does.
 */
function downgradeIdempotencyKey(
  userId: string,
  currentPeriodEnd: Date,
  isFollowUp: boolean,
  now: Date,
): string {
  const base = `downgrade:${userId}:${currentPeriodEnd.toISOString()}`;
  return isFollowUp ? `${base}:${now.toISOString()}` : base;
}

/**
 * Schedules a downgrade, effective at the current period's end. No
 * payment, no Flutterwave call: the user already paid for the period
 * they're in, so nothing is charged and nothing is granted here —
 * DOWNGRADE_SCHEDULED records an intent, not a grant (AGENTS.md). Access
 * does not change today; deriveEntitlement is what applies this once
 * `now` passes the boundary, and it does so on every call, with no cron
 * or background task involved.
 *
 * `now` is a parameter for the same reason as everywhere else in this
 * codebase: a test needs to control it, and this function must not decide
 * anything by reading the clock itself.
 */
export async function scheduleDowngrade(params: {
  userId: string;
  targetPlanCode: string;
  now: Date;
}): Promise<ScheduleDowngradeResult> {
  const { userId, targetPlanCode, now } = params;

  const targetPlan = await prisma.plan.findUnique({ where: { code: targetPlanCode } });
  if (!targetPlan || !targetPlan.active) {
    return { outcome: "invalid_target" };
  }
  if (targetPlan.interval === "NONE") {
    return { outcome: "target_is_free" };
  }

  const events = await prisma.paymentEvent.findMany({
    where: { userId },
    orderBy: { seq: "asc" },
  });
  const entitlement = deriveEntitlement(events, now);

  if (entitlement.status === "inconsistent") {
    return { outcome: "inconsistent" };
  }
  if (entitlement.periodEnd === null || !entitlement.accessGranted) {
    return { outcome: "no_active_paid_plan" };
  }
  if (entitlement.planCode === targetPlanCode) {
    return { outcome: "same_plan" };
  }

  // Compared by each plan's *current* price — this is a today's-catalogue
  // question ("does yearly cost more than monthly right now"), not a
  // historical one, so reading Plan here is fine (unlike during payment
  // verification, which checks a past record against what was actually
  // charged at the time).
  const currentPlan = await prisma.plan.findUnique({ where: { code: entitlement.planCode } });
  if (!currentPlan) {
    // FK-guaranteed to exist; defensive rather than asserted away.
    return { outcome: "inconsistent" };
  }
  if (targetPlan.amountMinor >= currentPlan.amountMinor) {
    return { outcome: "would_be_upgrade" };
  }

  const isFollowUp = entitlement.pendingPlanCode !== null;
  await appendPaymentEvent({
    type: "DOWNGRADE_SCHEDULED",
    userId,
    idempotencyKey: downgradeIdempotencyKey(userId, entitlement.periodEnd, isFollowUp, now),
    planCode: targetPlanCode,
  });

  // Subscription is a cache (AGENTS.md) — refreshed so pendingPlanCode is
  // visible without replaying the log, never read to decide anything.
  await refreshSubscriptionProjection(userId, now);

  return {
    outcome: "scheduled",
    currentPlanCode: entitlement.planCode,
    targetPlanCode,
    effectiveAt: entitlement.periodEnd,
  };
}

/**
 * Cancels a pending downgrade before it takes effect — see the module
 * comment above for how and why. Rejects if nothing is actually pending;
 * there is nothing to undo.
 */
export async function cancelScheduledDowngrade(params: {
  userId: string;
  now: Date;
}): Promise<CancelDowngradeResult> {
  const { userId, now } = params;

  const events = await prisma.paymentEvent.findMany({
    where: { userId },
    orderBy: { seq: "asc" },
  });
  const entitlement = deriveEntitlement(events, now);

  if (entitlement.status === "inconsistent") {
    return { outcome: "inconsistent" };
  }
  if (entitlement.pendingPlanCode === null || entitlement.periodEnd === null) {
    return { outcome: "no_pending_downgrade" };
  }

  // A downgrade is already pending, so this is always a follow-up action
  // — it always gets its own key, never the bare per-period one.
  await appendPaymentEvent({
    type: "DOWNGRADE_SCHEDULED",
    userId,
    idempotencyKey: downgradeIdempotencyKey(userId, entitlement.periodEnd, true, now),
    planCode: entitlement.planCode,
  });

  await refreshSubscriptionProjection(userId, now);

  return { outcome: "cancelled", planCode: entitlement.planCode };
}
