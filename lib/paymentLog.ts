import { Prisma, type PaymentEvent } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * The append-only payment log writer. This is the only place in this
 * codebase allowed to call `prisma.paymentEvent.create` — enforced by the
 * `no-restricted-syntax` rule in eslint.config.mjs, not only by this
 * comment. There is no update or delete path here, or anywhere: the log is
 * append-only, so there is nothing else to write.
 *
 * The check constraints on PaymentEvent (see the migrations) are the last
 * line of defence. This file's job is to make the same rules fail to
 * compile wherever possible, so a malformed event is caught before it ever
 * reaches the database. Two are modelled precisely here:
 * `PaymentEvent_grant_complete` — the type below requires exactly the
 * columns that constraint requires, no more and no less, for
 * `ENTITLEMENT_GRANTED` — and `PaymentEvent_reason_scoped_to_type` /
 * `PaymentEvent_cancellation_reason_required` together, which is why
 * `reason` is a required field on exactly `PaymentFailedInput` and
 * `CancellationReasonProvidedInput` below and absent from every other
 * type's interface — TypeScript rejects a `reason` on any of them before
 * the database ever gets a chance to. The other constraints are
 * amount/currency/period *validity* rules (non-negative, ISO-shaped,
 * correctly ordered, non-blank) rather than *presence* rules a
 * discriminated union can express, so those stay the database's job alone.
 */

interface CommonFields {
  userId: string;
  /** Composed by the caller per the table in AGENTS.md. This module never
   * invents a key — the whole point is that the caller's chosen key is what
   * the unique constraint enforces. */
  idempotencyKey: string;
  payload?: Prisma.InputJsonValue | null;
}

// --- Per-event-type shapes -------------------------------------------------
//
// Only the fields grounded in an actual schema comment, idempotency-key
// formula, or check constraint are required or excluded here. Anything this
// project hasn't yet decided a rule for (e.g. whether PAYMENT_VERIFIED ever
// carries a planCode) is left optional rather than guessed at.

export interface CheckoutInitiatedInput extends CommonFields {
  type: "CHECKOUT_INITIATED";
  /** Key is `checkout:{txRef}` — this is what ties the key to a real column. */
  txRef: string;
  planCode: string;
  /** The amount and currency quoted to the user at this exact moment —
   * not looked up again from Plan later. "Events carry their own facts"
   * (AGENTS.md): a dispute three months from now is answered from this
   * row, not from whatever Plan.amountMinor says by then. */
  amountMinor: number;
  currency: string;
}

export interface ProrationQuotedInput extends CommonFields {
  type: "PRORATION_QUOTED";
  /** Key is `quote:{txRef}`. */
  txRef: string;
  planCode: string;
  /** "creditAppliedMinor... Set on PRORATION_QUOTED (what the user was
   * shown)" — schema.prisma. amountMinor/currency are the quoted charge. */
  amountMinor: number;
  currency: string;
  creditAppliedMinor: number;
}

export interface PaymentVerifiedInput extends CommonFields {
  type: "PAYMENT_VERIFIED";
  /** Key is `verified:{providerTxId}`. */
  providerReference: string;
  /** The verified amount/currency — the whole point of this event. */
  amountMinor: number;
  currency: string;
  txRef?: string;
  planCode?: string;
}

export interface EntitlementGrantedInput extends CommonFields {
  type: "ENTITLEMENT_GRANTED";
  /** Key is `granted:{providerTxId}`. */
  providerReference: string;
  /** Required together — this is PaymentEvent_grant_complete, typed. */
  planCode: string;
  periodStart: Date;
  periodEnd: Date;
  amountMinor: number;
  currency: string;
  /** Optional even here: a fresh subscribe has no previous plan to credit
   * from. The constraint agrees — grant_complete does not require this. */
  creditAppliedMinor?: number;
  txRef?: string;
}

export interface PaymentFailedInput extends CommonFields {
  type: "PAYMENT_FAILED";
  /** Key is `failed:{txRef}` — a retry after failure uses a new txRef. */
  txRef: string;
  /** "Failure reason, or the user's cancellation reason" — schema.prisma. */
  reason: string;
  providerReference?: string;
  planCode?: string;
}

export interface WebhookReceivedInput extends CommonFields {
  type: "WEBHOOK_RECEIVED";
  /** Key is `webhook:{providerTxId}`. */
  providerReference: string;
  txRef?: string;
}

export interface WebhookDuplicateIgnoredInput extends CommonFields {
  type: "WEBHOOK_DUPLICATE_IGNORED";
  /** Key is `webhook-dup:{providerTxId}:{receivedAt ISO ms}`. */
  providerReference: string;
  txRef?: string;
}

export interface DowngradeScheduledInput extends CommonFields {
  type: "DOWNGRADE_SCHEDULED";
  /** The target plan — a downgrade with no destination is meaningless. */
  planCode: string;
}

export interface DowngradeCancelledInput extends CommonFields {
  type: "DOWNGRADE_CANCELLED";
  /** The plan that was pending, now cancelled. Descriptive, not required
   * by derivation (which clears pendingPlanCode unconditionally on this
   * event) — but keeps the row readable on its own, without decoding the
   * idempotencyKey's embedded seq reference to find out what it undid. */
  planCode?: string;
}

export interface CancellationRequestedInput extends CommonFields {
  type: "CANCELLATION_REQUESTED";
  planCode?: string;
}

export interface CancellationReasonProvidedInput extends CommonFields {
  type: "CANCELLATION_REASON_PROVIDED";
  /** "CANCELLATION_REASON_PROVIDED carries it" — AGENTS.md. Deliberately
   * not on CANCELLATION_REQUESTED: the brief's reason prompt happens after
   * cancellation, and the log is append-only, so it cannot be the same
   * event carrying a reason added later. */
  reason: string;
}

export type PaymentEventInput =
  | CheckoutInitiatedInput
  | ProrationQuotedInput
  | PaymentVerifiedInput
  | EntitlementGrantedInput
  | PaymentFailedInput
  | WebhookReceivedInput
  | WebhookDuplicateIgnoredInput
  | DowngradeScheduledInput
  | DowngradeCancelledInput
  | CancellationRequestedInput
  | CancellationReasonProvidedInput;

// --- Result -----------------------------------------------------------------

export type AppendResult =
  | { outcome: "inserted"; event: PaymentEvent }
  | { outcome: "duplicate"; idempotencyKey: string };

// --- Writer -----------------------------------------------------------------

function toCreateData(input: PaymentEventInput): Prisma.PaymentEventUncheckedCreateInput {
  const base = {
    userId: input.userId,
    type: input.type,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload ?? undefined,
  };

  switch (input.type) {
    case "CHECKOUT_INITIATED":
      return {
        ...base,
        txRef: input.txRef,
        planCode: input.planCode,
        amountMinor: input.amountMinor,
        currency: input.currency,
      };
    case "PRORATION_QUOTED":
      return {
        ...base,
        txRef: input.txRef,
        planCode: input.planCode,
        amountMinor: input.amountMinor,
        currency: input.currency,
        creditAppliedMinor: input.creditAppliedMinor,
      };
    case "PAYMENT_VERIFIED":
      return {
        ...base,
        providerReference: input.providerReference,
        txRef: input.txRef,
        planCode: input.planCode,
        amountMinor: input.amountMinor,
        currency: input.currency,
      };
    case "ENTITLEMENT_GRANTED":
      return {
        ...base,
        providerReference: input.providerReference,
        txRef: input.txRef,
        planCode: input.planCode,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        amountMinor: input.amountMinor,
        currency: input.currency,
        creditAppliedMinor: input.creditAppliedMinor,
      };
    case "PAYMENT_FAILED":
      return {
        ...base,
        txRef: input.txRef,
        reason: input.reason,
        providerReference: input.providerReference,
        planCode: input.planCode,
      };
    case "WEBHOOK_RECEIVED":
      return { ...base, providerReference: input.providerReference, txRef: input.txRef };
    case "WEBHOOK_DUPLICATE_IGNORED":
      return { ...base, providerReference: input.providerReference, txRef: input.txRef };
    case "DOWNGRADE_SCHEDULED":
      return { ...base, planCode: input.planCode };
    case "DOWNGRADE_CANCELLED":
      return { ...base, planCode: input.planCode };
    case "CANCELLATION_REQUESTED":
      return { ...base, planCode: input.planCode };
    case "CANCELLATION_REASON_PROVIDED":
      return { ...base, reason: input.reason };
    default: {
      const exhaustive: never = input;
      throw new Error(`Unhandled PaymentEventType: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function isUniqueConstraintViolation(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Appends one event to the log. Insert-and-catch, not check-then-insert:
 * the unique constraint on `idempotencyKey` is what actually guarantees a
 * repeated key produces one row, and a check-then-insert has a race between
 * the check and the insert that the constraint does not. Two concurrent
 * calls with the same key both reach the database; Postgres allows exactly
 * one to commit and rejects the other with a unique violation (P2002),
 * which this function turns into `{ outcome: "duplicate" }` rather than an
 * exception the caller has to remember to catch.
 *
 * Any other database error is rethrown — a duplicate is an expected,
 * distinguishable outcome; nothing else is.
 */
export async function appendPaymentEvent(input: PaymentEventInput): Promise<AppendResult> {
  try {
    const event = await prisma.paymentEvent.create({ data: toCreateData(input) });
    return { outcome: "inserted", event };
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      return { outcome: "duplicate", idempotencyKey: input.idempotencyKey };
    }
    throw err;
  }
}
