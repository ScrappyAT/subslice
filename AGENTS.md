# Project Context

## What this repository is

A single subscription and payment slice, built for Assessment 2 of a product engineering
bootcamp. The full brief is at `DOC/assessment-2-brief.md`. Read it before starting any
task.

This is **not** an application. It is one flow, built properly, with nothing around it.
Anything outside the brief is a liability, not a bonus.

## Stack

- Next.js (App Router), Prisma, PostgreSQL, TypeScript
- Payment provider: **Flutterwave API v3, test mode only**

Do not introduce new frameworks or ORMs. Do not add a payment SDK wrapper library — talk to
Flutterwave directly, or use their official SDK if one exists for this platform.

## Hard rules

1. **Never create, write to, or modify `.env`.** I write API keys by hand. You may edit
   `.env.example` with commented placeholders only.
2. **Never put a secret, key or credential in a source file**, including in a test, a
   comment, or an example.
3. **No card details are ever stored, logged, or passed through this application.** Card
   data goes from the user's browser to Flutterwave and never touches my server. Do not use
   any endpoint that accepts a card number, a PIN, an OTP or a payment-method object. If a
   design would require handling a card number, stop and tell me.
4. **Do not build anything in the "Do not build" list.** No landing page, no pricing
   marketing page, no product features behind the paywall.
5. **One step at a time.** Complete the single step I asked for, then stop and explain what
   you did. Do not proceed unprompted.
6. **Small commits.** Each step is its own commit.
7. **No placeholder or fake data anywhere.** Empty states must be genuine.

## Flutterwave — verified, do not re-research

Verification was completed on 8 September 2026. The findings, including the questions the
documentation could not answer, are in `DOC/flutterwave-verification.md`. The API version
decision is settled in the architectural decisions below. Do not re-research it, and do not
reopen it at build step 4 or step 6.

Two items are genuinely unresolved and must be confirmed against a live sandbox response,
not against the documentation:

- The complete field list returned by `GET /v3/transactions/{id}/verify`. The docs page did
  not render its schema. Log the full payload to `PaymentEvent.payload` on the first
  successful test transaction and read the real shape off that.
- The v3 test card list, including the failure cards. Confirm these work before the
  error-handling pass at step 13 depends on them.

## Architectural decisions — do not change these without asking

### Provider

- **Flutterwave API v3, pinned.** Base URL `https://api.flutterwave.com/v3`, held as a
  constant in config, not in `.env`. v4 is rejected: its charge flow requires a
  server-created payment-method object, which risks a card number reaching my server and
  breaking hard rule 3. The docs state the versions cannot be mixed. Do not use a v4
  endpoint, a v4 host, or the `flutterwave-signature` header anywhere in this project.

- **Checkout is the v3 Standard hosted redirect** (`POST /v3/payments`). Card data goes
  browser to Flutterwave. There is no server-side card path.

### Money

- **Money is stored as integers in minor units**, with the currency stored alongside it in
  the same row. Never a float, never a decimal type.

- **Amounts are sent to Flutterwave in major units and stored in minor units.** v3 expects
  major units. Conversion happens in exactly one function at the provider boundary, using
  integer arithmetic and string formatting — never floating-point division. The converted
  value is never persisted. On the way back in, the amount from the verify response is
  converted to minor units and compared as an integer against what was expected.

- **Rounding is in the customer's favour, in one place.** Proration credit rounds up. The
  resulting charge is floored at zero and can never be negative.

### The log

- **`PaymentEvent` is an append-only log and is the source of truth.** Rows are inserted,
  never updated, never deleted. `Subscription` is a derived projection of that log, and it
  must be possible to rebuild it from the events alone. This is the assessment's "excellent"
  band and it cannot be retrofitted — do not build a mutable status column and plan to add
  a log later.

- **Events carry their own facts.** Every event stores the plan code, amount, currency and
  period boundaries it establishes. Derivation must never read the `Plan` table for an
  amount, because plan prices can change and a rebuild of an old log must still produce the
  old numbers.

- **Replay order is by an explicit sequence column.** `PaymentEvent` has
  `seq Int @unique @default(autoincrement())` and derivation replays in `seq` order. `cuid`
  is not reliably sortable and two events can share a `createdAt` millisecond, so neither is
  a safe ordering key for something described as rebuildable.

- **Exactly one event type grants entitlement: `ENTITLEMENT_GRANTED`.** It carries
  `planCode`, `periodStart`, `periodEnd`, `amountMinor`, `currency` and
  `creditAppliedMinor`. No other event type may move the plan or the period. There is no
  `UPGRADE_PRORATED` event; the quote is recorded separately as `PRORATION_QUOTED` at
  initiation and grants nothing.

- **There is no `SUBSCRIPTION_EXPIRED` event.** Nothing schedules it and I do not want a
  cron job. Expiry is derived from `now > currentPeriodEnd`, the same way a scheduled
  downgrade is derived.

- **Derivation is a pure function of `(events, now)`.** `now` is injected as a parameter,
  never read from `new Date()` inside the logic. Without this I cannot test the day-12 of a
  30-day cycle case, or demonstrate period-end behaviour, without waiting a month.

- **`PaymentEvent.userId` is non-null with a foreign key**, so a webhook whose reference
  does not resolve to a known user cannot be recorded. This is deliberate: the event log is
  the source of truth and must not have an unauthenticated write path. An unresolvable
  reference returns 200 with no row written, and is logged to stdout only.

- **`Subscription` columns are for display only.** No code path may read `Subscription.status`,
  `cancelAtPeriodEnd`, `planCode` or the period columns to make an entitlement decision.
  Expiry is derived from `now > currentPeriodEnd`, so a stored `status` of `ACTIVE` on an
  expired row is possible by design. Every access decision goes through the derivation
  function, and that is the only place entitlement is decided.

### Verification and entitlement

- **Entitlement is granted only after server-side verification.** The user landing on the
  return URL is a hint that something happened, never proof. The server must call
  `GET /v3/transactions/{id}/verify`, confirm the status, amount and currency match what was
  expected, and only then write the fulfilment event. Reaching the return URL directly in a
  browser must grant nothing.

- **Webhook authenticity is a shared-secret equality check on the `verif-hash` header. It is
  not a signature.** The header value is a constant set in the dashboard, so it is
  replayable and carries no tamper-evidence over the request body. Do not describe it as a
  signature in code comments or in the documentation.

- **Because of the above, nothing in the webhook body is ever treated as fact.** The handler
  checks the header, extracts the transaction id, and then calls the verify endpoint.
  Amount, currency and status are read only from that authenticated response. A forged or
  tampered webhook therefore gains nothing, because the only thing read from it is an id
  that is then independently verified. This is how the brief's "signature verification
  before any processing" requirement is satisfied on a provider that has no signature.

- **Idempotency is enforced by a unique constraint in the database, not by a check-then-
  insert in application code.** `PaymentEvent.idempotencyKey` is non-null and unique. Insert
  and catch the unique violation; do not query first.

- **Two reference fields, two jobs.** `tx_ref` is mine and identifies one checkout attempt.
  Flutterwave's numeric transaction `id` is the anchor for verification and fulfilment
  events. Both are stored on the event row.

- **Idempotency key formulas.** A key that is too coarse turns a legitimate repeat action
  into a silently swallowed duplicate. Use exactly these:

  | Event | Key | Legitimate repeat it must not swallow |
  |---|---|---|
  | `CHECKOUT_INITIATED` | `checkout:{txRef}` | Abandoning checkout and starting again |
  | `PRORATION_QUOTED` | `quote:{txRef}` | Viewing the upgrade quote twice |
  | `PAYMENT_VERIFIED` | `verified:{providerTxId}` | — collision here is the point |
  | `ENTITLEMENT_GRANTED` | `granted:{providerTxId}` | — collision here is the point |
  | `PAYMENT_FAILED` | `failed:{txRef}` | A retry after failure uses a new `txRef` |
  | `WEBHOOK_RECEIVED` | `webhook:{providerTxId}` | — collision here is the point |
  | `WEBHOOK_DUPLICATE_IGNORED` | `webhook-dup:{providerTxId}:{receivedAt ISO ms}` | The same webhook arriving a third time |
  | `DOWNGRADE_SCHEDULED` | `downgrade:{userId}:{currentPeriodEnd ISO}` | Downgrading again in a later period |
  | `CANCELLATION_REQUESTED` | `cancel:{userId}:{currentPeriodEnd ISO}` | Cancelling, resubscribing, cancelling again |
  | `CANCELLATION_REASON_PROVIDED` | `cancel-reason:{userId}:{currentPeriodEnd ISO}` | As above |

### Lifecycle

- **I own the subscription lifecycle, not the provider.** Use Flutterwave for one-off
  charges. Period boundaries, upgrades, downgrades, proration and cancellation are my own
  logic, because the arithmetic is what is being assessed.

- **Proration is calculated by me and shown to the user before they confirm.** Day-accurate.
  Unused value on the current plan becomes a credit against the new plan's charge. The quote
  is written to the log as `PRORATION_QUOTED` at initiation, so what the user was shown is
  reconstructable and not only visible in an application log.

- **Downgrades are scheduled, not immediate.** The change applies at the end of the paid
  period. Upgrades are immediate with proration.

- **Cancellation retains access to the end of the paid period.** Never an immediate cutoff
  after taking payment for that period.

- **The cancellation reason is its own event.** The brief requires the reason to come from an
  optional prompt shown *after* cancellation, and the log is append-only, so the
  `CANCELLATION_REQUESTED` row cannot be updated later.
  `CANCELLATION_REASON_PROVIDED` carries it, and the projection reads the reason from that
  event. If the user skips the prompt, no second event is written and the reason stays null.

- **A billing anchor is not the same as a period boundary.** `currentPeriodEnd`
  can itself be a clamped date from a short month, so adding a cycle to it
  compounds the clamp and permanently loses the original day-of-month. Any
  code that extends a period — the pay-twice case in particular — must add
  cycles from the subscription's original anchor day, derived from the first
  `ENTITLEMENT_GRANTED` event in the log, not from whatever `currentPeriodEnd`
  currently holds.
  
  - **Derivation replays recorded periods; it does not recompute them.** The
  anchor-preserving extension math is a write-path responsibility. Any step
  that writes an `ENTITLEMENT_GRANTED` must derive the anchor from the first
  grant in the log and compute the new period with `addCalendarMonths`, and
  must assert that in its own tests. Derivation will faithfully replay a wrong
  period rather than catch it.
  
- **Paying twice for an active plan extends the period.** This is a different problem from a
  duplicate webhook: two genuine payments have two different provider references and both
  pass the idempotency constraint. The second `ENTITLEMENT_GRANTED` sets `periodStart` to the
  existing `periodEnd` and extends by one interval, so the money is never silently absorbed.
  Do not reject and do not refund — there is no refund path in this slice. This decision is
  the answer to defence question 4 and must be tested.

- **Every failure path renders something.** No blank page, no unhandled 404, no raw error
  string, at any point in the payment path.

### Schema constraints

Constraints are the last line of defence when application code has a bug, and Section 4 of
the documentation has to name what each one prevents. Include:

- Foreign keys from `Subscription.planCode`, `Subscription.pendingPlanCode` and
  `PaymentEvent.planCode` to `Plan.code`, so an invalid plan code is impossible.
- Check constraints, added in the migration as raw SQL since Prisma cannot express them:
  `amountMinor >= 0`; `currentPeriodEnd > currentPeriodStart`; and on `PaymentEvent`, that
  `amountMinor` and `currency` are either both null or both set — which is the actual reason
  currency is stored alongside the amount.

## Local development

Flutterwave cannot reach `localhost`, so webhook testing needs a tunnel. Set this up at step
7, before writing the webhook handler, and document the exact command in Section 2 of
`DOCUMENTATION.md` — a reviewer cannot test the webhook without it.

## Build order

Work through these in sequence. Do not skip ahead.

1. Project scaffold, `.env.example`, Prisma schema and initial migration
2. Plan configuration and money helpers, with amounts in minor units and one conversion
   function at the provider boundary
3. The append-only payment log writer, with idempotency enforced by a unique constraint
4. Entitlement derivation from the log, as a pure function of `(events, now)`
5. Unit tests for derivation: subscribe, upgrade on day 12 of 30, scheduled downgrade
   applying at the boundary, cancellation retaining access, paying twice. These tests
   double as the proration evidence, which is why they come before the UI
6. Checkout initiation endpoint, with rate limiting
7. The return view and server-side verification
8. Webhook endpoint, authenticity check, and duplicate handling
9. Upgrade with proration, quote shown before confirmation
10. Downgrade scheduled at period end
11. Cancellation with confirmation, and the optional reason prompt
12. Plans view, billing view, signed-in shell
13. Error handling pass across the whole payment path
14. `DOCUMENTATION.md`
15. LinkedIn post

**Evidence is captured at the step that produces it, not at the end.** The before-and-after
upgrade screenshots only exist at the moment of the upgrade. Keep a running scratch file of
every wrong turn as it happens — Section 6 needs three real problems with the dead ends
included, and those cannot be reconstructed honestly a week later.

## How to help me

I have to defend every line of this out loud, and answer questions like "show me the exact
line where entitlement is granted, and tell me what happens if I reach that code path
directly in my browser." So:

- Explain the reasoning behind what you write, briefly, as you write it.
- When there was a real alternative, name it and say why you did not take it.
- If I ask you to do something that contradicts the brief, say so instead of complying.
- Do not add error handling, abstraction, or features I did not ask for.
- Test the unhappy paths, not just the happy one. A duplicate webhook, a webhook arriving a
  third time, a failed payment, a tampered amount, a direct visit to the return URL, and
  paying twice in one minute.