import type { PaymentEvent } from "@prisma/client";
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
 * Cancelling a scheduled downgrade is its own event, DOWNGRADE_CANCELLED
 * (added in a follow-up migration to step 10) — not a DOWNGRADE_SCHEDULED
 * targeting the current plan. Overloading one event type to mean two
 * different things ("move to this plan" vs. "never mind") breaks the
 * property that the log is readable as a record of what happened; a new
 * enum value is one line of SQL, and the append-only design exists
 * precisely so a new fact gets a new row, not a repurposed one.
 * deriveEntitlement clears pendingPlanCode on DOWNGRADE_CANCELLED, and
 * treats one with nothing pending as an inconsistent log — not a no-op —
 * since cancelling only ever follows a schedule.
 *
 * The idempotency-key question, revisited: a count of prior events of a
 * type in a period ("n") is NOT race-safe, because computing it means
 * reading a count *before* inserting — a check-then-insert, the exact
 * pattern AGENTS.md's idempotency principle rules out. Two concurrent,
 * genuinely *different* decisions (not two retries of the same one) can
 * both read the same count before either commits, compute the same n, and
 * collide — silently dropping whichever loses the race, even though
 * neither request was ever a duplicate of the other.
 *
 * What IS race-safe: anchoring the key on the `seq` of the specific prior
 * event being superseded, rather than a freshly-computed tally. `seq` is
 * assigned by Postgres at insert time and is immutable once committed, so
 * reading it is reading an already-durable fact, not racing a count:
 * - The first DOWNGRADE_SCHEDULED in a period uses the bare AGENTS.md
 *   formula (`downgrade:{userId}:{currentPeriodEnd}`), exactly.
 * - A DOWNGRADE_SCHEDULED that follows a cancellation (a reschedule)
 *   anchors on that DOWNGRADE_CANCELLED's own seq.
 * - A DOWNGRADE_CANCELLED anchors on the seq of the specific
 *   DOWNGRADE_SCHEDULED it cancels.
 * Two concurrent attempts at the *same* logical action (a double-click on
 * "cancel") read the same already-committed anchor and correctly
 * collide. Two *different* actions never collide on each other at all,
 * because DOWNGRADE_SCHEDULED and DOWNGRADE_CANCELLED use different key
 * prefixes regardless of anchor.
 */
function downgradeScheduledKey(userId: string, currentPeriodEnd: Date, followsSeq: number | null): string {
  const base = `downgrade:${userId}:${currentPeriodEnd.toISOString()}`;
  return followsSeq === null ? base : `${base}:${followsSeq}`;
}

function downgradeCancelledKey(userId: string, currentPeriodEnd: Date, cancelsSeq: number): string {
  return `downgrade-cancel:${userId}:${currentPeriodEnd.toISOString()}:${cancelsSeq}`;
}

/** The event that established the current period — the anchor point after
 * which any DOWNGRADE_SCHEDULED/DOWNGRADE_CANCELLED activity belongs to
 * *this* period, not an earlier one. */
function findCurrentGrant(events: PaymentEvent[]): PaymentEvent | undefined {
  return events.filter((e) => e.type === "ENTITLEMENT_GRANTED").at(-1);
}

/** The most recent DOWNGRADE_SCHEDULED or DOWNGRADE_CANCELLED since the
 * current period began, if any — what a new action in this period follows. */
function findLatestDowngradeActivity(events: PaymentEvent[], afterSeq: number): PaymentEvent | undefined {
  return events
    .filter((e) => e.seq > afterSeq && (e.type === "DOWNGRADE_SCHEDULED" || e.type === "DOWNGRADE_CANCELLED"))
    .at(-1);
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
 * `now` is a parameter for the same reason it is everywhere else in this
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

  const currentGrant = findCurrentGrant(events);
  if (!currentGrant) {
    // entitlement.periodEnd !== null already guarantees a grant exists.
    return { outcome: "inconsistent" };
  }
  const priorActivity = findLatestDowngradeActivity(events, currentGrant.seq);

  await appendPaymentEvent({
    type: "DOWNGRADE_SCHEDULED",
    userId,
    idempotencyKey: downgradeScheduledKey(userId, entitlement.periodEnd, priorActivity?.seq ?? null),
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
 * Cancels a pending downgrade before it takes effect. Rejects if nothing
 * is actually pending — there is nothing to undo, and writing
 * DOWNGRADE_CANCELLED anyway would make the log inconsistent by its own
 * rule (see lib/entitlement.ts).
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

  const currentGrant = findCurrentGrant(events);
  const pendingSchedule = currentGrant
    ? events.filter((e) => e.seq > currentGrant.seq && e.type === "DOWNGRADE_SCHEDULED").at(-1)
    : undefined;
  if (!pendingSchedule) {
    // entitlement.pendingPlanCode !== null already guarantees this exists.
    return { outcome: "inconsistent" };
  }

  await appendPaymentEvent({
    type: "DOWNGRADE_CANCELLED",
    userId,
    idempotencyKey: downgradeCancelledKey(userId, entitlement.periodEnd, pendingSchedule.seq),
    planCode: entitlement.pendingPlanCode,
  });

  await refreshSubscriptionProjection(userId, now);

  return { outcome: "cancelled", planCode: entitlement.planCode };
}
