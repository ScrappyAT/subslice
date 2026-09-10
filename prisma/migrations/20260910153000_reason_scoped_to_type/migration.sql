-- CheckConstraint
-- Prevents: a reason recorded on any event type other than the two that
-- ever legitimately carry one — CANCELLATION_REASON_PROVIDED (the user's
-- typed reason) and PAYMENT_FAILED (why a checkout attempt failed). A
-- reason on, say, ENTITLEMENT_GRANTED would be meaningless: there is
-- nothing to explain about a successful grant.
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_reason_scoped_to_type" CHECK (
  "type" IN ('CANCELLATION_REASON_PROVIDED', 'PAYMENT_FAILED') OR "reason" IS NULL
);

-- CheckConstraint
-- Prevents: CANCELLATION_REASON_PROVIDED existing with no reason at all —
-- the entire point of this event type is to carry one. (deriveEntitlement
-- already treats a null reason here as inconsistent; this is the same
-- rule enforced at the source instead of only at read time.)
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_cancellation_reason_required" CHECK (
  "type" <> 'CANCELLATION_REASON_PROVIDED' OR "reason" IS NOT NULL
);

-- CheckConstraint
-- Prevents: a reason that is empty or whitespace-only, on either event
-- type that carries one. A form-level `.min(1).trim()` (zod, in
-- lib/validation/schemas.ts) already stops this from a browser request;
-- this is the same rule enforced independently of that request path, at
-- the one place every write — including a future one that bypasses the
-- form — must still pass through.
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_reason_not_blank" CHECK (
  "reason" IS NULL OR btrim("reason") <> ''
);
