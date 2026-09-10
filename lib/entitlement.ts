import type { PaymentEvent } from "@prisma/client";
import type { PlanCode } from "./plans";

/**
 * Entitlement derivation — the pure core the assessment's "excellent" band
 * rests on. `Subscription` is a cache of whatever this function last
 * computed; this function is the only place entitlement is actually
 * decided. No database access, no `new Date()`, no Plan table lookup:
 * every fact this needs is already sitting on the event rows, because
 * AGENTS.md requires events to carry their own facts precisely so a
 * rebuild never depends on anything that can change out from under it.
 */

export interface EntitlementState {
  status: "ok";
  /** What the last ENTITLEMENT_GRANTED established. "free" until the first
   * one ever happens — nobody starts on a paid plan without paying. */
  planCode: PlanCode;
  /** Function of the period and `now`, not a stored flag. An expired
   * period grants nothing even though no event marked it expired. */
  accessGranted: boolean;
  /** Null exactly when planCode is "free" and always has been — a plan
   * nobody has ever paid for has no period to speak of. */
  periodStart: Date | null;
  periodEnd: Date | null;
  /** A downgrade scheduled for the current period, not yet in effect.
   * Null once the boundary has passed and it has been applied. */
  pendingPlanCode: PlanCode | null;
  /** Set by a cancellation request for the current period. Access is not
   * cut immediately — accessGranted still follows periodEnd as normal. */
  cancelAtPeriodEnd: boolean;
  cancellationReason: string | null;
}

/**
 * Returned instead of throwing or guessing when the log tells a story this
 * function cannot make sense of — e.g. a downgrade scheduled with no active
 * plan to downgrade from. A caller must handle this explicitly; there is no
 * default entitlement to fall back on when the history itself doesn't add
 * up.
 */
export interface InconsistentLog {
  status: "inconsistent";
  reason: string;
  /** The event whose replay first produced the inconsistency, for tracing
   * back into the log. */
  atSeq: number;
}

export type Entitlement = EntitlementState | InconsistentLog;

function inconsistent(reason: string, atSeq: number): InconsistentLog {
  return { status: "inconsistent", reason, atSeq };
}

/**
 * Replays `events` in `seq` order — never `createdAt`. Two events can share
 * a createdAt millisecond and cuid is not chronologically sortable; `seq`
 * is the only column AGENTS.md designates as the replay order, and this is
 * the one place that ordering is load-bearing.
 *
 * `seq` is arrival order at this database — assigned by Postgres at INSERT
 * time — not the order the underlying real-world events occurred at
 * Flutterwave. A known, accepted consequence, stated here rather than
 * left to be discovered, in its precise form (narrower than "a retried
 * webhook", which conflates two different things):
 *
 * - A webhook retried for a transaction ALREADY granted collides on
 *   ENTITLEMENT_GRANTED's own idempotency key (`granted:{providerTxId}`,
 *   AGENTS.md) and writes nothing new — appendPaymentEvent reports
 *   `{ outcome: "duplicate" }`. It cannot reactivate a cancelled user (or
 *   do anything else), because no new event exists for derivation to
 *   apply, regardless of what arrived after what.
 * - A genuinely delayed delivery for a DISTINCT transaction — one that
 *   has never been granted, arriving late (network failure, Flutterwave's
 *   own retry schedule, this server briefly down) after some other event,
 *   e.g. a cancellation, that a human would say happened later in the
 *   real world — is not a duplicate at all. It gets a fresh, higher `seq`
 *   than that cancellation, and derivation applies it *after* the
 *   cancellation, full stop.
 *
 * Only the second case reaches derivation; the first never produces a row
 * to reorder in the first place. This is deliberate, not a gap: `seq` is
 * the only ordering this system can make an atomic, race-free guarantee
 * about (Postgres-assigned, immutable once committed); a provider-supplied
 * timestamp cannot be, since it is exactly the kind of external,
 * unverifiable input AGENTS.md already treats the rest of a webhook body
 * as (see app/api/webhooks/flutterwave/route.ts — only `id` is ever read
 * from it, as a pointer to re-verify, never as fact). Pinned in
 * lib/cancellation.test.ts's "a fulfilment event wins over an earlier
 * cancellation regardless of which has the later createdAt" case (a
 * distinct-transaction scenario, per the distinction above).
 */
export function deriveEntitlement(events: PaymentEvent[], now: Date): Entitlement {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);

  let planCode: PlanCode = "free";
  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;
  let pendingPlanCode: PlanCode | null = null;
  let cancelAtPeriodEnd = false;
  let cancellationReason: string | null = null;

  for (const event of ordered) {
    switch (event.type) {
      case "ENTITLEMENT_GRANTED": {
        // The only event type that moves the plan or the period — every
        // other case below either records an attempt, an intent that takes
        // effect later, or nothing actionable at all.
        if (
          event.planCode === null ||
          event.periodStart === null ||
          event.periodEnd === null ||
          event.amountMinor === null ||
          event.currency === null
        ) {
          // PaymentEvent_grant_complete requires these five together at the
          // database level. This log predates that constraint, or bypassed
          // it — either way, derivation cannot proceed as if this event
          // were complete, so it stops here rather than guessing.
          return inconsistent(
            "ENTITLEMENT_GRANTED is missing one of planCode, periodStart, periodEnd, amountMinor, currency",
            event.seq,
          );
        }
        if (periodEnd !== null && event.periodEnd.getTime() <= periodEnd.getTime()) {
          // Every grant is supposed to move access forward — an extension
          // to a later end, or an upgrade to a later end. One that doesn't
          // is not a state this function can reconcile on its own.
          return inconsistent(
            "ENTITLEMENT_GRANTED did not move periodEnd forward",
            event.seq,
          );
        }
        planCode = event.planCode as PlanCode;
        periodStart = event.periodStart;
        periodEnd = event.periodEnd;
        // A fresh grant supersedes whatever was pending against the period
        // it replaces — a schedule or a cancellation made against the old
        // period has nothing left to apply to.
        pendingPlanCode = null;
        cancelAtPeriodEnd = false;
        cancellationReason = null;
        break;
      }

      case "DOWNGRADE_SCHEDULED": {
        if (periodEnd === null) {
          return inconsistent(
            "DOWNGRADE_SCHEDULED with no active plan to downgrade from",
            event.seq,
          );
        }
        if (event.planCode === null) {
          return inconsistent("DOWNGRADE_SCHEDULED is missing planCode", event.seq);
        }
        // Scheduling a downgrade is a decision to leave the current plan,
        // not to leave the plan entirely — it supersedes any cancellation
        // pending against this same period. Last action wins.
        pendingPlanCode = event.planCode as PlanCode;
        cancelAtPeriodEnd = false;
        cancellationReason = null;
        break;
      }

      case "DOWNGRADE_CANCELLED": {
        if (pendingPlanCode === null) {
          // Cancelling only ever follows a schedule. Nothing pending
          // means there is nothing this event could be undoing — not a
          // no-op, a story the log cannot make sense of.
          return inconsistent(
            "DOWNGRADE_CANCELLED with no pending downgrade to cancel",
            event.seq,
          );
        }
        pendingPlanCode = null;
        break;
      }

      case "CANCELLATION_REQUESTED": {
        if (periodEnd === null) {
          return inconsistent(
            "CANCELLATION_REQUESTED with no active plan to cancel",
            event.seq,
          );
        }
        // Symmetric with the above: choosing to cancel supersedes a
        // downgrade scheduled earlier in the same period.
        cancelAtPeriodEnd = true;
        pendingPlanCode = null;
        break;
      }

      case "CANCELLATION_REASON_PROVIDED": {
        if (!cancelAtPeriodEnd) {
          // The brief's reason prompt only ever follows a cancellation.
          // A reason with nothing to attach to is not a state this
          // function invents an explanation for.
          return inconsistent(
            "CANCELLATION_REASON_PROVIDED with no matching CANCELLATION_REQUESTED",
            event.seq,
          );
        }
        if (event.reason === null) {
          return inconsistent("CANCELLATION_REASON_PROVIDED is missing reason", event.seq);
        }
        cancellationReason = event.reason;
        break;
      }

      // Everything below is ignored for entitlement purposes. Each is
      // listed explicitly, with why, rather than falling through a
      // catch-all — the point of this switch is that "ignored" is a
      // decision, not an omission.
      case "CHECKOUT_INITIATED":
        // An attempt to start a checkout. Attempting proves nothing was
        // paid.
        break;
      case "PRORATION_QUOTED":
        // Records what a quote showed the user before they confirmed.
        // Showing a number grants nothing.
        break;
      case "PAYMENT_VERIFIED":
        // Records that Flutterwave confirmed a transaction succeeded.
        // Verification is deliberately a separate step from fulfilment —
        // only the ENTITLEMENT_GRANTED that follows it grants anything.
        break;
      case "PAYMENT_FAILED":
        // A failed attempt. Grants nothing by definition.
        break;
      case "WEBHOOK_RECEIVED":
        // A record that an authenticated webhook arrived. The webhook body
        // is never treated as fact (AGENTS.md) — this event exists for the
        // audit trail, not to move entitlement.
        break;
      case "WEBHOOK_DUPLICATE_IGNORED":
        // Explicitly a no-op record of a repeat webhook. Zero effect is
        // the entire point of this event type.
        break;
      default: {
        const exhaustive: never = event.type;
        return inconsistent(`Unhandled PaymentEventType: ${String(exhaustive)}`, event.seq);
      }
    }
  }

  // The boundary is crossed by time passing, not by a write — nothing
  // schedules this check, it runs every time deriveEntitlement is called.
  const boundaryPassed = periodEnd !== null && now.getTime() >= periodEnd.getTime();
  if (boundaryPassed && pendingPlanCode !== null) {
    // The scheduled downgrade takes effect: the plan on record changes.
    // This does not fabricate a new paid period — nothing was paid for
    // one. periodStart/periodEnd stay exactly as the last grant left them;
    // accessGranted below is already false past this same boundary either
    // way.
    planCode = pendingPlanCode;
    pendingPlanCode = null;
  }

  const accessGranted = periodEnd !== null && now.getTime() < periodEnd.getTime();

  return {
    status: "ok",
    planCode,
    accessGranted,
    periodStart,
    periodEnd,
    pendingPlanCode,
    cancelAtPeriodEnd,
    cancellationReason,
  };
}
