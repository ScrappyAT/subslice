import { prisma } from "./prisma";
import { deriveEntitlement } from "./entitlement";
import { appendPaymentEvent } from "./paymentLog";
import { refreshSubscriptionProjection } from "./subscriptionProjection";
import type { PlanCode } from "./plans";

export type PreviewCancellationResult =
  | { outcome: "previewed"; planCode: PlanCode; periodEnd: Date }
  /** planCode here is always "free" — deriveEntitlement's own contract is
   * that planCode is never absent, only ever the plan actually on record
   * (AGENTS.md). Step 12 renders against this: a discriminated union where
   * every branch names the plan, never one where the caller has to treat
   * "no result" as "must be free". */
  | { outcome: "no_active_paid_plan"; planCode: PlanCode }
  | { outcome: "inconsistent" };

/**
 * The confirmation step (step 11): computes what cancelling would mean —
 * the plan they'd stay on and the date access ends — without writing
 * anything. Cancellation must not be a single unconfirmed click; this is
 * what the user is shown before requestCancellation is ever called.
 */
export async function previewCancellation(params: {
  userId: string;
  now: Date;
}): Promise<PreviewCancellationResult> {
  const events = await prisma.paymentEvent.findMany({
    where: { userId: params.userId },
    orderBy: { seq: "asc" },
  });
  const entitlement = deriveEntitlement(events, params.now);

  if (entitlement.status === "inconsistent") {
    return { outcome: "inconsistent" };
  }
  if (entitlement.periodEnd === null || !entitlement.accessGranted) {
    return { outcome: "no_active_paid_plan", planCode: entitlement.planCode };
  }

  return { outcome: "previewed", planCode: entitlement.planCode, periodEnd: entitlement.periodEnd };
}

export type RequestCancellationResult =
  | { outcome: "cancelled"; planCode: PlanCode; periodEnd: Date }
  | { outcome: "already_cancelled"; planCode: PlanCode; periodEnd: Date }
  | { outcome: "no_active_paid_plan"; planCode: PlanCode }
  | { outcome: "inconsistent" };

/**
 * On confirmation: writes CANCELLATION_REQUESTED, keyed
 * `cancel:{userId}:{currentPeriodEnd ISO}` per AGENTS.md — unchanged from
 * the bare formula, no seq-anchoring needed the way DOWNGRADE_SCHEDULED
 * required it, because there is no built path to un-cancel and re-cancel
 * within the same period (see the reactivation note in this module's
 * header docs) — a genuine repeat of this exact action within one period
 * is meant to collide, not produce a second row.
 *
 * No refund, no immediate revocation, no ENTITLEMENT_GRANTED: this records
 * an intent, the same as DOWNGRADE_SCHEDULED does. Access is retained to
 * the end of the paid period — an immediate cutoff right after taking
 * payment for that period is the brief's named trap, and this function
 * never revokes anything; deriveEntitlement's accessGranted keeps
 * following periodEnd exactly as it did before this event existed.
 *
 * Interaction with a scheduled downgrade: cancelling supersedes a pending
 * downgrade (lib/entitlement.ts already clears pendingPlanCode on
 * CANCELLATION_REQUESTED, symmetric with DOWNGRADE_SCHEDULED clearing
 * cancelAtPeriodEnd — "last action wins", built in step 4 and unchanged
 * here). The two are not left to coexist, because they cannot both be
 * true at the boundary: a downgrade only means something for a user who
 * is still a customer afterward, and cancelling says the opposite. Which
 * *should* win if both are somehow live is exactly the ambiguity "coexist"
 * fails to resolve — it just defers the same question to boundary time
 * instead of answering it now. Superseding immediately also keeps the
 * record honest: after the boundary, planCode should reflect the last
 * plan actually paid for and used (e.g. yearly), not a downgrade target
 * (monthly) the user left before it ever took effect.
 */
export async function requestCancellation(params: {
  userId: string;
  now: Date;
}): Promise<RequestCancellationResult> {
  const events = await prisma.paymentEvent.findMany({
    where: { userId: params.userId },
    orderBy: { seq: "asc" },
  });
  const entitlement = deriveEntitlement(events, params.now);

  if (entitlement.status === "inconsistent") {
    return { outcome: "inconsistent" };
  }
  if (entitlement.periodEnd === null || !entitlement.accessGranted) {
    return { outcome: "no_active_paid_plan", planCode: entitlement.planCode };
  }
  if (entitlement.cancelAtPeriodEnd) {
    return { outcome: "already_cancelled", planCode: entitlement.planCode, periodEnd: entitlement.periodEnd };
  }

  await appendPaymentEvent({
    type: "CANCELLATION_REQUESTED",
    userId: params.userId,
    idempotencyKey: `cancel:${params.userId}:${entitlement.periodEnd.toISOString()}`,
    planCode: entitlement.planCode,
  });

  // Subscription is a cache (AGENTS.md) — refreshed so cancelAtPeriodEnd
  // and cancelledAt are visible without replaying the log, never read to
  // decide anything.
  await refreshSubscriptionProjection(params.userId, params.now);

  return { outcome: "cancelled", planCode: entitlement.planCode, periodEnd: entitlement.periodEnd };
}

export type ProvideCancellationReasonResult =
  | { outcome: "recorded" }
  | { outcome: "no_pending_cancellation" }
  | { outcome: "inconsistent" };

/**
 * The reason prompt: shown after cancellation is already recorded, and
 * skippable — skipping simply means this is never called, so no second
 * event is written and the reason stays null. Calling this always means
 * "here is a reason"; there is no separate "skip" signal to handle here.
 * The projection reads the reason from this event, not from
 * CANCELLATION_REQUESTED — that row is never updated, because the log is
 * append-only.
 */
export async function provideCancellationReason(params: {
  userId: string;
  reason: string;
  now: Date;
}): Promise<ProvideCancellationReasonResult> {
  const events = await prisma.paymentEvent.findMany({
    where: { userId: params.userId },
    orderBy: { seq: "asc" },
  });
  const entitlement = deriveEntitlement(events, params.now);

  if (entitlement.status === "inconsistent") {
    return { outcome: "inconsistent" };
  }
  if (!entitlement.cancelAtPeriodEnd || entitlement.periodEnd === null) {
    return { outcome: "no_pending_cancellation" };
  }

  await appendPaymentEvent({
    type: "CANCELLATION_REASON_PROVIDED",
    userId: params.userId,
    idempotencyKey: `cancel-reason:${params.userId}:${entitlement.periodEnd.toISOString()}`,
    reason: params.reason,
  });

  await refreshSubscriptionProjection(params.userId, params.now);

  return { outcome: "recorded" };
}

/**
 * Reactivation ("un-cancel" before the period ends): not built in this
 * step. Nothing in AGENTS.md or the brief names it as a required
 * capability, unlike the downgrade schedule/cancel/reschedule cycle,
 * which AGENTS.md's own idempotency table already anticipated
 * ("cancelling, resubscribing, cancelling again"). Building it would need,
 * by direct analogy with DOWNGRADE_CANCELLED (this codebase's most recent
 * precedent for exactly this kind of change):
 * - a new PaymentEventType value (e.g. CANCELLATION_WITHDRAWN) — a
 *   one-line migration, the same shape as DOWNGRADE_CANCELLED's;
 * - a deriveEntitlement case clearing cancelAtPeriodEnd (and
 *   cancellationReason) on it, and treating one with no cancellation
 *   pending as inconsistent rather than a no-op — mirroring
 *   DOWNGRADE_CANCELLED's rule exactly;
 * - a seq-anchored idempotency key,
 *   `cancel-withdrawn:{userId}:{currentPeriodEnd}:{seq of the
 *   CANCELLATION_REQUESTED it withdraws}`, for the same race-safety reason
 *   DOWNGRADE_SCHEDULED's follow-up key needed one;
 * - an endpoint.
 * None of that exists here — a signed-in user who has cancelled currently
 * has no way to undo it before the period ends.
 */
