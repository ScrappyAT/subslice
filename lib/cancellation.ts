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
  /** planCode is `null`, not omitted and not a guessed "free": derivation
   * itself could not produce a plan here (the log did not add up), so
   * there genuinely is nothing to name. A step-12 renderer that
   * destructures `planCode` off every branch is forced to see this one
   * explicitly rather than have it silently be `undefined`. */
  | { outcome: "inconsistent"; planCode: null };

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
    return { outcome: "inconsistent", planCode: null };
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
  | { outcome: "inconsistent"; planCode: null };

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
    return { outcome: "inconsistent", planCode: null };
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
  | { outcome: "inconsistent"; planCode: null };

/**
 * The reason prompt: shown after cancellation is already recorded, and
 * skippable — skipping simply means this is never called, so no second
 * event is written and the reason stays null. Calling this always means
 * "here is a reason"; there is no separate "skip" signal to handle here.
 * The projection reads the reason from this event, not from
 * CANCELLATION_REQUESTED — that row is never updated, because the log is
 * append-only.
 *
 * The `!entitlement.cancelAtPeriodEnd` check below is the orphan-reason
 * guard: it runs, and can reject, BEFORE appendPaymentEvent is ever
 * called, so an orphan CANCELLATION_REASON_PROVIDED (one with no
 * cancellation to attach to) never enters the log through this function —
 * this is the only write path that produces this event type. Derivation's
 * own "CANCELLATION_REASON_PROVIDED with no matching CANCELLATION_REQUESTED"
 * inconsistency (lib/entitlement.ts) is a backstop for a log that
 * acquired such a row some other way (a hand-written insert, a bug in a
 * future write path) — not the check that fires in normal operation. In
 * the only path that exists today, this guard always fires first, and the
 * derivation-level check never has anything to catch.
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
    return { outcome: "inconsistent", planCode: null };
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
 * Reactivation — two different things, one built, one not:
 *
 * 1. A FREE reactivation ("un-cancel", a click that reverses the flag with
 *    no money changing hands): still not built. Nothing in AGENTS.md or
 *    the brief names it as a required capability, unlike the downgrade
 *    schedule/cancel/reschedule cycle, which AGENTS.md's own idempotency
 *    table already anticipated ("cancelling, resubscribing, cancelling
 *    again"). Building it would need, by direct analogy with
 *    DOWNGRADE_CANCELLED (this codebase's most recent precedent for
 *    exactly this kind of change): a new PaymentEventType (e.g.
 *    CANCELLATION_WITHDRAWN), a deriveEntitlement case clearing
 *    cancelAtPeriodEnd on it and treating one with nothing pending as
 *    inconsistent, a seq-anchored idempotency key, and an endpoint. None
 *    of that exists — a signed-in user who has cancelled has no *free* way
 *    back before the period ends.
 *
 * 2. Reactivation via a genuine PAID ENTITLEMENT_GRANTED: already built,
 *    deliberately, and this is the rule, stated explicitly rather than
 *    left as an incidental reading of "clears a flag":
 *
 *    A real payment for continued access on the same plan, arriving while
 *    cancelAtPeriodEnd is true and access has not yet lapsed, reactivates
 *    — cancelAtPeriodEnd clears (lib/entitlement.ts's ENTITLEMENT_GRANTED
 *    case, unconditional). This is not modelled as a distinct event type:
 *    ENTITLEMENT_GRANTED already fully records the fact ("money was paid,
 *    access continues") the same way it does for a plain extension: real
 *    money, a real later periodEnd, both readable straight off the row.
 *    A separate "SUBSCRIPTION_REACTIVATED" row would duplicate a fact
 *    already implied by this ENTITLEMENT_GRANTED plus the
 *    CANCELLATION_REQUESTED before it — the same reasoning schema.prisma
 *    gives for not storing an expiry event.
 *
 *    "Extension of an active plan" and "reactivation of a cancelled one"
 *    are distinguished by inspecting the state *immediately before* this
 *    grant, not by anything on the grant itself: replay events[0..seq-1]
 *    — if cancelAtPeriodEnd was already false, this is a plain extension;
 *    if it was true, this is a reactivation. Both are visible and provable
 *    from the log alone (lib/cancellation.test.ts's
 *    "cancel anchored to P1... a fulfilment event extends the period"
 *    case pins exactly this: cancelAtPeriodEnd true right before the
 *    second grant, false immediately after it).
 *
 *    This is a decision, not a gap: a webhook cannot be guarded at a route
 *    (Flutterwave calls it directly, with no confirmation step this app
 *    controls), so the rule has to live in derivation, applying uniformly
 *    to every trigger that can produce an ENTITLEMENT_GRANTED — the
 *    checkout return view, the webhook, and an upgrade confirmation alike
 *    (see lib/upgradeConfirm.ts's own note on this).
 *
 *    No refund is modelled for the alternative (cancellation standing
 *    despite a new payment) because that alternative was rejected: it
 *    would mean charging a customer for extended access and then denying
 *    them that access anyway, which is a worse outcome than the one
 *    chosen, not a safer one.
 */
