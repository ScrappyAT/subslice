# DOCUMENTATION

Assessment 2 — The Payment and Subscription Slice.

---

## Evidence Index

Sixteen files in `evidence/`, referenced by filename throughout this document exactly as
they exist on disk — several carry inconsistent extensions (a stray double `.png.jpeg`,
`.jpg`/`.jpeg` instead of `.png`, one double-dotted filename) rather than the clean names
used when discussing them; the table below and every in-text reference use the real,
current names, not corrected ones. The brief's five mandatory evidence items, mapped:

| Brief requirement | Evidence file(s) |
|---|---|
| Subscription record before and after an upgrade — interval changed, period end moved | `12-subscription-before-upgrade.png`, `14-subscription-after-upgrade.png` |
| Payment log for one complete transaction, each stage its own row with timestamps | `09-payment-log-upgrade-lifecycle.jpeg` (one upgrade transaction's full stage sequence); `20-full-lifecycle-log.png` (the fuller account history, also Section 6 Problem 4's evidence) |
| Proration calculation with real numbers, and the resulting log entries | `13-upgrade-quote-as-shown.png` (the quote as shown); `09-payment-log-upgrade-lifecycle.jpeg` / `20-full-lifecycle-log.png` (the resulting `PRORATION_QUOTED`/`ENTITLEMENT_GRANTED` rows) |
| The same webhook fired twice, second one recorded and ignored | `08-duplicate-webhook-recorded-once-acted-once.jpg` |
| A cancelled subscription showing access retained and the period end date | `19-subscription-cancelled-access-retained.png` |

The remaining files, for the steps that produced them: `07-return-view-verified-success.png.jpeg`,
`07-return-view-forged-transaction-id-rejected.png.jpeg` (step 7); `09-subscription-after-upgrade.jpeg`
(step 9, the earlier account's own before/after counterpart to `09-payment-log-upgrade-lifecycle.jpeg` —
there is no `09-subscription-before-upgrade` file, so this one stands alone rather than as a pair);
`10-downgrade-scheduled-pending-plan.jpg` (step 10); `11-plans-view-free-state.png` (step 12);
`15-downgrade-scheduled-on-yearly.png`, `16-billing-view-active.png` (step 12/12b);
`17-cancellation-confirmation-page.png`, `18-cancellation-reason-prompt..png` (step 11/12).

## Section 1: What This Is

This is a subscription and payment slice built on Next.js (App Router), Prisma and
PostgreSQL, charging through Flutterwave's v3 hosted checkout in test mode. A signed-in
user can subscribe to a monthly or yearly plan, upgrade from monthly to yearly mid-cycle
with a day-accurate prorated charge, schedule a downgrade that takes effect at the end
of the paid period, and cancel while keeping access until the period they already paid
for actually ends. Every one of those actions is recorded as its own row in an
append-only payment event log (`PaymentEvent`); nothing about what a user is entitled to
is read from a mutable status column — it is derived, on every request, by replaying
that log through a single pure function (`lib/entitlement.ts`'s `deriveEntitlement`).
`Subscription` exists only as a cache of whatever that function last computed, for cheap
reads on the billing and plans views, and it is rebuilt from the log rather than trusted
on its own.

Authentication — sign up, sign in, email verification, password reset, sessions — is
reused from Assessment 1, imported by hand into this repository rather than rebuilt (see
Section 4 for the reused tables, and `lib/auth/`, `components/Field.tsx`, and
`app/(auth)/*` for the reused code). Deliberately excluded, per the brief's own "do not
build" list: a landing page, pricing marketing copy, and any product feature gated
behind the paywall — the thing being sold is a plan flag on a user record and nothing
more. Also out of scope by design, not oversight: refunds (there is no refund path
anywhere in this codebase — a duplicate or excess payment extends access rather than
being reversed), a free "un-cancel" control, dunning/retry logic for failed recurring
charges, invoices, and proration on a downgrade (downgrades are scheduled for the period
boundary, not charged or credited mid-cycle, because nothing is owed until that boundary
arrives).

## Section 2: How To Run It

**Environment variables** (every one this application reads; there are no others —
confirmed by searching the codebase for every `process.env` reference):

| Variable | Value | Where it comes from |
|---|---|---|
| `DATABASE_URL` | `postgresql://subslice:PASSWORD@localhost:5434/subslice?schema=public` | The local Postgres container started by `docker-compose.yml` in this repo. Port `5434`, not the Postgres default `5432` — deliberately, so it never collides with a different local project on `5433`/`5432`. |
| `FLW_SECRET_KEY` | (blank in `.env.example`, fill in by hand) | Flutterwave dashboard → Settings → API keys → **V3 Test API keys** → Secret key. Test mode only. |
| `FLW_SECRET_HASH` | (blank in `.env.example`, fill in by hand) | A random string you generate yourself (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), then paste into Flutterwave dashboard → Settings → Webhooks → Secret hash. It must match exactly on both sides — this is a shared secret, not something Flutterwave issues to you. |
| `APP_BASE_URL` | `http://localhost:3000` | This application's own public base URL, used to build the `redirect_url` Flutterwave sends the browser back to after checkout. **Always `localhost` in local development — never a tunnel URL.** See below, and Section 6, Problem 1. |

`.env.example`'s own final comment ("copy the session and email variables from
auth-slice/.env.example") is stale: this codebase's reused auth does not actually read
any environment variable of its own. `lib/email.ts`'s `sendEmail` is a `console.log`
stub, not a real provider, and `lib/auth/session.ts` needs nothing beyond
`NODE_ENV` (standard, not something you set). The four variables above are the complete
list.

**From a fresh clone:**

1. `npm install`
2. `docker compose up -d` — starts local Postgres on port 5434 (`docker-compose.yml`).
3. `cp .env.example .env`, then fill in `FLW_SECRET_KEY` and `FLW_SECRET_HASH` by hand.
   Never commit `.env` — it is git-ignored (`.gitignore`: `.env*`, with `!.env.example`
   as the one exception).
4. `npx prisma migrate deploy` — applies all five migrations in
   `prisma/migrations/` in order, non-interactively. The first
   (`20260908150000_init`) also seeds the three sellable `Plan` rows (`free`, `monthly`,
   `yearly`) as part of the migration itself — there is no separate seed script to run.
5. `npx prisma generate` — generates the Prisma client.
6. `npm run dev` — starts the Next.js dev server.
7. Open `http://localhost:3000` — redirects to `/signin`.

**To test the webhook** (optional, only needed to exercise `app/api/webhooks/flutterwave/route.ts`
directly rather than relying on the return view): Flutterwave cannot reach
`localhost`, so it needs a tunnel. Run, in a separate terminal:

```
cloudflared tunnel --url http://localhost:3000 --edge-ip-version 4
```

Take the `https://*.trycloudflare.com` URL cloudflared prints and paste it into the
Flutterwave dashboard's **Webhooks → URL** field only. `APP_BASE_URL` in `.env` stays
`http://localhost:3000` the entire time — it must never be set to the tunnel URL. Section
6, Problem 1, is the whole story of what happens when that rule is broken.

`npm test` runs the suite (125 tests across 12 files, all against the real local
database, none of them stubbing Postgres). `npm run lint` runs ESLint, including a
project-specific rule that only `lib/paymentLog.ts` may call `prisma.paymentEvent.create`
directly (`eslint.config.mjs`).

## Section 3: The Flow, Step By Step

**Signing in.** Reused from Assessment 1 — `app/(auth)/signin/page.tsx` posts to
`app/api/auth/signin/route.ts`, which sets a session cookie (`lib/auth/session.ts`).
Not re-documented here beyond that; this slice's own work starts at the signed-in shell.

**The signed-in shell.** Every page under `app/(app)/` — `dashboard`, `plans`, `billing`,
`cancel` — sits inside `app/(app)/layout.tsx`, which calls `requireSession()` once. That
function (`lib/auth/session.ts`) is wrapped in React's `cache()`, so the layout's call and
each page's own subsequent call to it (needed again there, for the actual `user.id`
value) resolve the same memoized lookup within one request rather than hitting the
database twice. `app/checkout/return/page.tsx` sits outside this group and calls
`requireSession()` directly itself (see Section 7 for why it has no shared layout).

**Viewing plans.** `app/(app)/plans/page.tsx` calls `lib/plans.ts`'s `listActivePlans()`
for the three plan rows and `lib/currentEntitlement.ts`'s `getCurrentEntitlement(userId,
now)` for what the signed-in user currently has — which is exactly
`prisma.paymentEvent.findMany` ordered by `seq`, replayed through `deriveEntitlement`.
Nothing on this page, or anywhere under `app/(app)/`, reads the `Subscription` table.
The current-plan badge does not use `entitlement.planCode` directly — it uses
`effectivePlanForDisplay` (`lib/currentEntitlement.ts:36`), the one render-time
projection that turns a lapsed subscriber's still-on-record plan into "free" for display
purposes only (see Section 5, Cancellation, and the Section 6 note on `planCode` never
resetting itself). The action controls (`components/PlanActions.tsx`) are wired to the
existing endpoints only, one control per current state — subscribe, upgrade (quote then
confirm), downgrade, or cancel a scheduled downgrade.

**Subscribing.** Clicking "Subscribe" (`components/PlanActions.tsx`'s `subscribe`)
`POST`s `{ planCode }` to `app/api/checkout/route.ts`. That route checks the session,
validates the body (`lib/validation/schemas.ts`'s `checkoutSchema`), checks the
per-user rate limit (`lib/rate-limit.ts`, `RATE_LIMITS.checkout` — 10 attempts per 10
minutes, keyed `checkout:user:{id}`), looks the plan up against the real `Plan` table
(never a hardcoded list), and calls `lib/checkoutInitiation.ts`'s
`initiateCheckoutCharge`. That function writes `CHECKOUT_INITIATED` to the log *before*
it ever calls Flutterwave (`lib/flutterwave/payments.ts`'s `initiatePayment`, `POST
/v3/payments`), so a crash or provider outage between the two still leaves a record that
the attempt happened. The response is a `checkoutUrl`; the browser is sent there, and
from there to Flutterwave's own hosted card page — this application never receives a
card number, a PIN or an OTP.

**Landing back.** Flutterwave redirects the browser to `APP_BASE_URL/checkout/return`
with `tx_ref`, `transaction_id`, and a claimed `status` in the query string.
`app/checkout/return/page.tsx` reads `tx_ref` and `transaction_id` only —
`status` is explicitly discarded (`void params.status;`, line 29) because it is exactly
the brief's named trap: a value anyone can type into the URL by hand. Everything else is
handed to `lib/fulfilCheckout.ts`'s `fulfilCheckout`, which is the *only* place in this
codebase that writes `ENTITLEMENT_GRANTED` (line 451). It short-circuits first if this
`transaction_id` was already granted (line 164, see Section 6, Problem 4); otherwise it
finds the matching `CHECKOUT_INITIATED` row, confirms the `tx_ref` belongs to the
signed-in user, calls Flutterwave's `GET /v3/transactions/{id}/verify`
(`lib/flutterwave/verify.ts`), and only if that authenticated response's status, amount
and currency all match what was recorded at checkout does it write `PAYMENT_VERIFIED`
and then `ENTITLEMENT_GRANTED`. Before computing the new period it derives current
entitlement from the log (line 375) — extending the existing period if this is a second
payment on the same still-active plan, or starting a fresh one otherwise — and refuses
to grant at all if that derivation comes back `"inconsistent"` (line 383, see Section 6,
Problem 4's aftermath). The page renders one of six outcomes
(`granted`/`duplicate`/`pending`/`rejected`/`needs_review`), never a blank page.

**The webhook.** `app/api/webhooks/flutterwave/route.ts` is the second trigger for the
same `fulfilCheckout` code path. It checks the `verif-hash` header against
`FLW_SECRET_HASH` with a constant-time comparison (line 40, `constantTimeEquals`) before
reading anything else — a wrong or missing header writes nothing. Nothing in the webhook
body is ever treated as fact: only an `id` is extracted from it, as a pointer, and the
same authenticated `verifyTransaction` call decides everything. A first delivery writes
`WEBHOOK_RECEIVED`; a repeat writes `WEBHOOK_DUPLICATE_IGNORED` and never calls
`fulfilCheckout` a second time for it.

**Upgrading.** From the plans view, "Upgrade to Yearly" first `POST`s to
`app/api/upgrade/quote/route.ts`, which calls `lib/upgradeQuote.ts`'s `quoteUpgrade` —
derives current entitlement, prorates against yearly's current price
(`lib/proration.ts`'s `prorate`), and writes `PRORATION_QUOTED` recording exactly what
was shown. The quote is displayed inline (`components/PlanActions.tsx`), with an
explicit "Confirm upgrade" step — never auto-confirmed. Confirming `POST`s the quote's
`txRef` to `app/api/upgrade/confirm/route.ts`, which calls `lib/upgradeConfirm.ts`'s
`confirmUpgrade`: it *recomputes* the charge from the current entitlement and the
current time (never trusting the client, and never blindly reusing the earlier quote,
since real time has passed) and only proceeds — through the same
`initiateCheckoutCharge` a plain subscribe uses — if the recomputed number still matches
what was quoted. If it doesn't, it returns `"stale"` rather than silently charging a
different number (see Section 5, Proration). From there the flow rejoins the checkout
return path above.

**Downgrading.** "Downgrade to Monthly" `POST`s `{ targetPlanCode: "monthly" }` to
`app/api/downgrade/route.ts`, calling `lib/downgrade.ts`'s `scheduleDowngrade`. No
payment, no Flutterwave call — this writes `DOWNGRADE_SCHEDULED` only, an intent that
`deriveEntitlement` applies once `now` passes the current period's boundary
(`lib/entitlement.ts:256`). A scheduled downgrade can be cancelled from the plans view
(`POST /api/downgrade/cancel`, `lib/downgrade.ts`'s `cancelScheduledDowngrade`), writing
`DOWNGRADE_CANCELLED`.

**Cancelling.** The billing view's "Cancel subscription" link goes to
`app/(app)/cancel/page.tsx`, a server component that calls `lib/cancellation.ts`'s
`previewCancellation` directly — the same function `GET /api/cancel/preview` calls —
writing nothing. It renders the plan and access-until date via `components/CancelFlow.tsx`,
a client component. Confirming there `POST`s to `app/api/cancel/confirm/route.ts`
(`requestCancellation`), writing `CANCELLATION_REQUESTED` — never `ENTITLEMENT_GRANTED`,
never an immediate cutoff; `deriveEntitlement`'s `accessGranted` keeps following the
already-paid-for `periodEnd` exactly as before. The optional reason prompt that follows
is a second, skippable `POST` to `app/api/cancel/reason/route.ts`
(`provideCancellationReason`), writing `CANCELLATION_REASON_PROVIDED` only if the user
actually submits one.

## Section 4: The Data Model

| Table | Holds |
|---|---|
| `User` | One row per account. Reused from Assessment 1. |
| `Session` | An active signed-in session (hashed token, not the raw cookie value). Reused. |
| `VerificationCode`, `PasswordResetToken` | Reused auth flows unrelated to payments. |
| `RateLimitHit` | One row per allowed request against a rate-limited key; pruned as it ages out of the window (`lib/rate-limit.ts`). |
| `Plan` | The three sellable plans (`free`, `monthly`, `yearly`), seeded by migration. |
| `PaymentEvent` | The append-only log — the source of truth for what happened and what a user is entitled to. |
| `Subscription` | A derived, non-authoritative cache of whatever `deriveEntitlement` last computed, for cheap reads. |

**`PaymentEvent`, column by column, and the decision behind each:**
- `seq` (`Int @unique @default(autoincrement())`) — the replay order. Not `createdAt`:
  two events can share a millisecond, and `cuid` (the `id` column) is not chronologically
  sortable. This is the one column `deriveEntitlement` trusts for ordering.
- `type` — the `PaymentEventType` enum, twelve values (`CHECKOUT_INITIATED`,
  `PRORATION_QUOTED`, `PAYMENT_VERIFIED`, `ENTITLEMENT_GRANTED`, `PAYMENT_FAILED`,
  `WEBHOOK_RECEIVED`, `WEBHOOK_DUPLICATE_IGNORED`, `DOWNGRADE_SCHEDULED`,
  `DOWNGRADE_CANCELLED`, `CANCELLATION_REQUESTED`, `CANCELLATION_REASON_PROVIDED`,
  `FULFILMENT_DUPLICATE_IGNORED`). Exactly one of these, `ENTITLEMENT_GRANTED`, ever
  moves the plan or the period.
- `planCode` — a foreign key to `Plan.code`, not a free string, so an invalid plan code
  can never enter the log.
- `txRef` / `providerReference` — two reference fields with two different jobs. `txRef`
  is this application's own identifier for one checkout attempt; `providerReference` is
  Flutterwave's numeric transaction id. Both are stored, because a dispute months later
  needs to trace both "which attempt" and "which provider transaction" independently.
- `amountMinor` / `currency` — integer minor units and a three-letter currency code,
  stored together or not at all (see the constraint below). Never a float, never a
  `Decimal`.
- `creditAppliedMinor` — the proration credit, recorded on both `PRORATION_QUOTED` (what
  the user was shown) and `ENTITLEMENT_GRANTED` (what was actually applied), so the
  arithmetic is reconstructable from the log alone.
- `periodStart` / `periodEnd` — the period an event establishes or ends, where relevant.
- `reason` (`VarChar(500)`) — a failure reason or the user's typed cancellation reason.
  Scoped, at the database level, to exactly these two event types (see the constraints
  below), and length-bounded independently of the `zod` schema in front of it.
- `payload` (`Json?`) — the complete raw Flutterwave response, for dispute evidence.
  Never contains card data — Flutterwave's own API never sends it.
- `idempotencyKey` (`@unique`) — the actual mechanism idempotency rests on. See Section
  5.

**Constraints, and what each makes impossible** (all from the migrations in
`prisma/migrations/`, since Prisma's own schema syntax cannot express a `CHECK`):

| Constraint | Table | Prevents |
|---|---|---|
| `PaymentEvent_idempotencyKey_key` (unique) | PaymentEvent | Two rows with the same idempotency key — this is what makes a repeated webhook or a repeated fulfilment trigger record once, not an application-level check. |
| `PaymentEvent_userId_fkey`, `..._planCode_fkey`; `Subscription_planCode_fkey`, `..._pendingPlanCode_fkey` | PaymentEvent, Subscription | A payment event or a subscription pointing at a user or a plan code that does not exist. |
| `Plan_amountMinor_nonnegative`, `PaymentEvent_amountMinor_nonnegative`, `PaymentEvent_credit_nonnegative` | Plan, PaymentEvent | A negative price, charge, or proration credit. |
| `Plan_currency_iso`, `PaymentEvent_currency_iso` | Plan, PaymentEvent | A currency code that is not three uppercase letters. |
| `PaymentEvent_amount_currency_pair` | PaymentEvent | An amount recorded with no currency, or a currency with no amount. |
| `PaymentEvent_period_pair` | PaymentEvent | A period with only one boundary recorded, or one where the end is not strictly after the start. |
| `PaymentEvent_grant_complete` | PaymentEvent | An `ENTITLEMENT_GRANTED` row missing any of `planCode`, `periodStart`, `periodEnd`, `amountMinor`, `currency` — a grant that moves entitlement without a complete, honest record of what it granted. |
| `PaymentEvent_reason_scoped_to_type` | PaymentEvent | A `reason` recorded on any event type other than `PAYMENT_FAILED` or `CANCELLATION_REASON_PROVIDED`. |
| `PaymentEvent_cancellation_reason_required` | PaymentEvent | A `CANCELLATION_REASON_PROVIDED` row with no reason at all. |
| `PaymentEvent_reason_not_blank` | PaymentEvent | A reason that is empty or whitespace-only. |

Two things this schema does **not** prevent at the database level, stated honestly rather
than implied: `Subscription.currentPeriodEnd > currentPeriodStart` has no `CHECK`
constraint of its own (unlike `PaymentEvent`'s `period_pair`) — `Subscription` is
populated only by `refreshSubscriptionProjection` (`lib/subscriptionProjection.ts`),
trusted application code, not user input, so it doesn't carry the same validation
burden as a column a request body can reach. And nothing at the database level stops two
`ENTITLEMENT_GRANTED` rows from describing overlapping periods — that check
(`event.periodEnd` must move strictly forward) lives in `deriveEntitlement`
(`lib/entitlement.ts:126`) instead, because it is a *sequence* rule across rows, not a
fact about any single row a `CHECK` constraint can see.

## Section 5: The Concepts

### Minor units and why money is never a decimal

**What it is.** Every amount in this system — a plan's price, a charge, a proration
credit — is stored as a plain integer counting the currency's smallest unit (kobo for
NGN), never a float and never a `Decimal` column.

**Why it is needed.** A float cannot represent most decimal fractions exactly (`0.1 +
0.2 !== 0.3` in IEEE 754), so repeated arithmetic on money-as-float silently drifts. A
`Decimal` type avoids that specific problem but reintroduces string/precision handling at
every arithmetic site, and this project's provider boundary (Flutterwave) itself speaks
major-unit decimal strings on the wire — the safest design is to never hold that
representation anywhere except the one conversion point.

**How I implemented it.** `PaymentEvent.amountMinor`/`Plan.amountMinor` are `Int`
columns. The one conversion function, `lib/money.ts`'s `toProviderAmount`/`fromProviderAmount`,
sits at the provider boundary and does the major/minor conversion by string slicing on
the digits (`splitMinorUnits`), not by division — `toProviderAmount(250000, "NGN") ===
"2500.00"`. The converted value is never persisted; only the minor-units integer is.
`fromProviderAmount` explicitly rejects a value with more fractional digits than the
currency allows, rather than silently rounding a provider-reported amount.

**What I chose against, and why.** A `Decimal`/`numeric` Postgres column, with
`Prisma.Decimal` in application code. Rejected because it still requires careful
string-based arithmetic to avoid the same class of precision bug as float, for no
benefit over a plain integer once minor units are the unit of account — and it would
have meant a second representation (major-unit `Decimal` at rest, major-unit string on
the wire, minor-unit integer nowhere) instead of one.

### The payment lifecycle: initiation, verification and fulfilment

**What it is.** Three distinct steps, each its own event type: `CHECKOUT_INITIATED`
(the attempt begins), `PAYMENT_VERIFIED` (Flutterwave's own server confirms the
transaction succeeded), `ENTITLEMENT_GRANTED` (access is actually extended).

**Why it is needed.** The brief's named trap is granting a subscription the moment a
user lands on the success URL — a URL is not proof, only a hint that *something*
happened. Collapsing verification and fulfilment into one step would also make it
impossible to record "we confirmed this was real" as a fact independent of "and then we
acted on it", which is exactly the distinction defence question 1 probes.

**How I implemented it.** `lib/checkoutInitiation.ts` writes `CHECKOUT_INITIATED` before
ever calling Flutterwave. `lib/fulfilCheckout.ts` calls `GET
/v3/transactions/{id}/verify` and writes `PAYMENT_VERIFIED` only if that response's own
status is `"successful"` and the amount/currency match what was recorded at checkout
(`lib/fulfilCheckout.ts:346`, four separate checks above it). `ENTITLEMENT_GRANTED` is
written immediately after, in the same function call, at line 451 — the exact line
defence question 1 asks for. Reaching `/checkout/return` directly, with any
transaction id that doesn't pass every check, grants nothing (`"rejected"`).

**What I chose against, and why.** Trusting the return URL's `?status=successful` query
parameter, which the brief explicitly names as the trap. Rejected outright — that value
is read into a variable (`void params.status;`, `app/checkout/return/page.tsx:29`) and
never used for anything.

### The payment log and what it proves in a dispute

**What it is.** `PaymentEvent`, an append-only table — rows are inserted, never updated
or deleted — that is the actual source of truth, not `Subscription`'s cached columns.

**Why it is needed.** The brief's own trap: "the subscription table already shows a
status" is not the same claim as "here is what happened, in order, with timestamps". A
status column is the present; the log is the history, and the history is what a dispute
is resolved against.

**How I implemented it.** Every write goes through `lib/paymentLog.ts`'s
`appendPaymentEvent`, the only function in the codebase allowed to call
`prisma.paymentEvent.create` (enforced by an ESLint rule, `eslint.config.mjs`, not only a
comment). Nothing updates or deletes a row. For defence question 2 — a customer
disputes a charge from three months ago — the answer is: query
`PaymentEvent` for that user ordered by `seq`, and read the `CHECKOUT_INITIATED` →
`PAYMENT_VERIFIED` → `ENTITLEMENT_GRANTED` triple for that `providerReference`, which
between them carry the quoted amount, the verified amount, the raw provider response
(`payload`), and the exact period granted — none of it read from `Subscription`, which
is only ever a cache of what this same log already said.

**What I chose against, and why.** A mutable `Subscription.status` column as the only
record, updated in place on every transition. Rejected as exactly the trap named above —
it would answer "what is true now" and nothing about "what happened, when, and why",
which is the actual content of a dispute.

### Idempotency in payments

**What it is.** The guarantee that a repeated action — a retried webhook delivery, a
second visit to the return URL for the same transaction — records once and is acted on
once, never twice.

**Why it is needed.** Both the return view and the webhook can independently trigger
fulfilment for the same transaction (`app/checkout/return/page.tsx` and `app/api/webhooks/flutterwave/route.ts`
both call `lib/fulfilCheckout.ts`'s `fulfilCheckout`). Without a real guarantee, that
race can grant entitlement twice, or (as this project discovered — Section 6, Problem 4)
misrecord a redundant retry as an outright failure.

**How I implemented it.** A unique database constraint on `PaymentEvent.idempotencyKey`,
not a check-then-insert in application code — `appendPaymentEvent` inserts and catches
the unique-constraint violation (Postgres error code `P2002`), turning it into `{
outcome: "duplicate" }` (`lib/paymentLog.ts:315`). A check-then-insert has a race between
the read and the write that a database constraint does not: two concurrent calls with
the same key both reach Postgres, and exactly one commits. Every event type has its own
key formula (documented in full in `AGENTS.md`'s idempotency table) — `granted:{providerTxId}`
for `ENTITLEMENT_GRANTED`, `verified:{providerTxId}` for `PAYMENT_VERIFIED`, both keyed
on the provider's own transaction id specifically *because* collision there is the
point. Defence question 4 — paying for yearly twice in one minute — is answered by
`lib/fulfilCheckout.test.ts`'s "two grants for monthly" case and its yearly/anchor
equivalents: two genuine payments have two different `providerReference` values, both
pass the idempotency constraint (neither is a duplicate of the other), and the second
`ENTITLEMENT_GRANTED` extends the period from where the first left off rather than
overlapping it or silently absorbing the second payment.

**What I chose against, and why.** A count of prior events of a type as the
idempotency-key input (e.g. `downgrade:{userId}:{n}`) for the one case — scheduling then
cancelling a downgrade — where the same event type can legitimately recur within one
period. Rejected: computing `n` means reading a count *before* inserting, which is a
check-then-insert race in disguise — two concurrent, genuinely different decisions can
read the same count before either commits and collide. The chosen alternative anchors
the key on the `seq` of the specific prior event being superseded instead (e.g.
`downgrade:{userId}:{periodEnd}:{seq of the DOWNGRADE_CANCELLED it follows}`) — `seq` is
Postgres-assigned at insert time and immutable once committed, so reading it is reading
an already-durable fact, not racing a tally.

### Webhook signature verification

**What it is.** A check that an incoming webhook request genuinely came from
Flutterwave before any of its contents are acted on.

**Why it is needed.** Without it, anyone who discovers the webhook URL could POST a
fabricated "payment succeeded" body and potentially grant themselves entitlement for
nothing.

**How I implemented it.** A constant-time equality check
(`app/api/webhooks/flutterwave/route.ts:23`, `constantTimeEquals`, built on Node's
`timingSafeEqual`) between the request's `verif-hash` header and the locally-configured
`FLW_SECRET_HASH`. A wrong or missing header returns 401 and writes nothing. Critically,
this must be named precisely and not oversold: **this is a shared-secret equality check,
not a cryptographic signature.** The header value is a constant Flutterwave's v3 API
sets once in the dashboard and sends back unchanged on every webhook — it is replayable,
and it carries no tamper-evidence over the request body at all, unlike an HMAC signature
computed *over* the payload. Because of that, nothing in the webhook body is ever
treated as fact regardless of whether the header matches: the handler extracts only an
`id` from the body (`app/api/webhooks/flutterwave/route.ts:67`) and uses it purely as a
pointer to independently call `GET /v3/transactions/{id}/verify` — the authenticated
response, not the webhook body, is what amount, currency and status are ever read from.
A forged or tampered webhook that somehow also knew the correct `verif-hash` value would
still gain nothing beyond triggering a real, independent re-verification of whatever
transaction id it named.

**What I chose against, and why.** Flutterwave v4's `flutterwave-signature` header,
which is an actual HMAC-style signature over the request body. Rejected per `AGENTS.md`'s
pinned decision: v4's charge flow requires a server-created payment-method object, which
risks a card number reaching this server and breaking the hard rule that no card data is
ever stored, logged, or passed through this application. v3 does not have an
equivalent signature primitive, so this project satisfies the brief's "signature
verification before any processing" requirement the only way available on the provider
version its other hard rules require — by making the *action taken* on the webhook
depend entirely on an independent, authenticated verify call, never on the header or the
body being trustworthy in themselves.

### Proration

**What it is.** The prorated amount charged when a user upgrades from monthly to yearly
mid-cycle: the unused value on the current plan becomes a credit against the new plan's
price.

**Why it is needed.** Charging the full yearly price on top of a monthly period the user
already partly paid for would double-charge for days already covered; the brief requires
this calculated and shown before the user confirms, not silently applied.

**How I implemented it.** `lib/proration.ts`'s `prorate` — `creditMinor =
ceil(paidAmountMinor * daysRemaining / daysInPeriod)`, `chargeMinor = max(0,
newPlanAmountMinor - creditMinor)`. Rounding is in the customer's favour in exactly one
direction: the credit rounds up (`Math.ceil`), and the resulting charge is floored at
zero — it can never go negative, and there is no refund path if the credit would have
exceeded the new plan's price. `daysInPeriod`/`daysRemaining` (`lib/period.ts`) count
whole days over the true calendar period, with elapsed time floored (a partial day
already lived in doesn't count as fully used), so remaining time is never
under-counted. The quote is written to the log as `PRORATION_QUOTED`
(`lib/upgradeQuote.ts:101`) at the moment it is shown, carrying the exact numbers, so
what the user saw is reconstructable from the log alone and not only from a screenshot.

The live quote actually captured for this documentation's evidence
(`13-upgrade-quote-as-shown.png`) is a **day-0** upgrade: the monthly subscription it
upgrades from was only minutes old at the time, so the entire month is still unused and
the full monthly payment becomes the credit. As shown to the user, and matching
`PaymentEvent` seq 5013 on the account that evidence run used:

> 30 of 30 days remain on the current period
> Credit for unused time: ₦2,500.00
> Charge today: ₦22,500.00

(Yearly is ₦25,000.00, monthly is ₦2,500.00 — `2500000` and `250000` minor units,
matching the seeded `Plan` rows exactly.) This is not the day-12-of-a-cycle case the
brief's defence question 3 asks to be walked through — it is presented here as what it
actually is, a day-0 upgrade, not dressed up as something else.

The day-12 arithmetic defence question 3 actually asks for comes from
`lib/upgrade.test.ts`'s derivation test, with `now` injected rather than waited for:
a monthly period `[1 Jan, 1 Feb)` — 31 days, since January genuinely has 31 (this
codebase tracks the calendar, never an assumed 30-day cycle) — evaluated at `now = 13
Jan` (day 12 elapsed, 19 remaining):

> `daysInPeriod = 31`, `daysRemaining = 19`
> `creditMinor = ceil(250000 * 19 / 31) = 153226` (₦1,532.26)
> `chargeMinor = 2500000 - 153226 = 2346774` (₦23,467.74)

`now` is a parameter to every derivation and proration function in this codebase
precisely so this exact case — and the day-0 case above, and the period-boundary case
below — are all testable by injecting a value, rather than needing to wait a month or a
year for the real clock to reach them.

**What I chose against, and why.** Prorating a downgrade symmetrically (a credit for the
unused value on the more expensive plan). Rejected — the brief specifies downgrades take
effect at the period boundary, at which point nothing is being cut short and there is
nothing to credit; adding proration there would be solving a problem the chosen design
(schedule, don't charge) doesn't have.

### Cancellation and period-end access

**What it is.** A user who cancels keeps access until the period they already paid for
ends — never an immediate cutoff — with an explicit confirmation step before anything is
written, and an optional reason prompt after.

**Why it is needed — the legal reasoning.** The user has already paid for that period in
full; cutting access off immediately after taking that payment is, in substance, keeping
money for a service then not providing it. The brief names this as one of its traps for
exactly that reason. A confirmation step exists because cancellation is a
consequential, one-directional action from the user's point of view (there is no
built "un-cancel" — see Section 7) and must not be triggerable by a single accidental
click or a GET request.

**How I implemented it.** `requestCancellation` (`lib/cancellation.ts:86`) writes
`CANCELLATION_REQUESTED` — an intent, exactly like `DOWNGRADE_SCHEDULED` — and nothing
else. It never writes `ENTITLEMENT_GRANTED`, never revokes anything: `deriveEntitlement`'s
`accessGranted` keeps following the existing `periodEnd` precisely as it did before this
event existed (`lib/entitlement.ts:266`). The confirmation page
(`app/(app)/cancel/page.tsx`) is a GET that calls `previewCancellation` — the same
function backing `previewCancellation`'s own preview logic — which writes nothing at all;
the one write in the whole flow is the explicit `POST` a confirmation button triggers
(`components/CancelFlow.tsx`). The optional reason prompt shown after is a second,
separate event type, `CANCELLATION_REASON_PROVIDED` (`lib/cancellation.ts:159`) — its own
row rather than an edit to the `CANCELLATION_REQUESTED` row, because the log is
append-only and the brief's reason prompt can arrive after cancellation is already
recorded. Skipping the prompt means this function is simply never called; no "skipped"
event exists, and the reason column stays `null`.

**What I chose against, and why.** A free "un-cancel" control that simply reverses the
flag with no payment involved. Not built — nothing in the brief names it as required,
and building it would mean a new event type, a new derivation case, and a new endpoint
for a capability outside scope (see Section 7). A genuine new *payment* on the same plan
while still within the cancelling grace period does clear `cancelAtPeriodEnd` — this is
`ENTITLEMENT_GRANTED`'s own unconditional behaviour (`lib/entitlement.ts:142`), applying
uniformly to every trigger that can produce a grant — but that is reactivation through a
real transaction, not a free control.

### Why cards are not stored, naming PCI scope

**What it is.** No card number, expiry, CVV, PIN or OTP is ever received, stored, logged,
or passed through this application's own server.

**Why it is needed.** Beyond the brief's own hard requirement, handling card data
directly would place this application's own servers inside PCI DSS scope for storing,
processing or transmitting cardholder data — a substantial compliance burden (network
segmentation, access logging, regular audits) that a bootcamp assessment slice has no
business taking on, and that a real product should only take on deliberately.

**How I implemented it.** Checkout is the Flutterwave v3 **Standard hosted redirect**
(`POST /v3/payments`, `lib/flutterwave/payments.ts`) — the browser is sent to a page
Flutterwave itself serves and controls, enters card details there, and is redirected
back with only a transaction reference. This server never renders a card field, never
receives a payment-method object, and the one function that talks to Flutterwave for
initiation (`initiatePayment`) sends only the amount, currency, `tx_ref` and a redirect
URL — nothing card-shaped is even a parameter it could accept. Because every cardholder-data
function is fully outsourced to a redirect to a PCI DSS-validated third party, with none
of it touching this application's own systems, the applicable self-assessment
questionnaire under this design is **SAQ A** — the category for merchants with no
electronic storage, processing, or transmission of cardholder data on their own systems.

**What I chose against, and why.** Flutterwave v4's charge flow, which requires the
merchant's own server to create a payment-method object — meaning a card number would
need to reach this server at least in transit, even if never persisted. Rejected outright
(`AGENTS.md`'s pinned provider decision) specifically because it would widen PCI scope
for no benefit this assessment needs, and because the two API versions cannot be mixed.

### Rate limiting on payment endpoints

**What it is.** A cap on how many times one user can hit a payment-provider-calling
endpoint in a given window.

**Why it is needed.** `/api/checkout` and `/api/upgrade/confirm` both write a log row
*and* make a real request to Flutterwave on every call; with no limit, a script (or a
frustrated double-click loop) could generate an unbounded number of provider calls and
log rows from one account.

**How I implemented it.** `lib/rate-limit.ts`'s `checkRateLimit`, backed by a
`RateLimitHit` table pruned of anything outside the current window on each check. Keyed
per user (`checkout:user:{id}`, `upgrade-confirm:user:{id}`) rather than per IP, since
both routes require a session — the user *is* the identity that matters here, unlike the
anonymous auth endpoints reused from Assessment 1. `RATE_LIMITS.checkout` and
`.upgradeConfirm` both allow 10 attempts per 10 minutes: generous enough for a genuine
user abandoning checkout and retrying (including a run of real provider failures), tight
enough to bound the worst case. A rejected request returns 429 with a `Retry-After`
header (`app/api/checkout/route.ts:44`); only an *allowed* request counts toward the
limit, so a blocked user retrying while still blocked cannot push the window forward
indefinitely.

**What I chose against, and why.** Rate limiting by IP address for these two routes,
matching the anonymous auth endpoints' own convention. Rejected: both routes always have
a session by the time they run, and an IP-based key would let one user rotate networks to
evade the limit, while also wrongly sharing one limit across unrelated users behind the
same IP (e.g. a shared office network).

## Section 6: What Went Wrong

### Problem 1 — a live payment stranded on a dead tunnel

**Symptom.** A real bank-transfer payment completed successfully on Flutterwave's side —
the money was taken — but the browser, redirected back to `APP_BASE_URL/checkout/return`,
hit `DNS_PROBE_FINISHED_NXDOMAIN` instead of the return view. No entitlement was
granted, and the page gave no indication anything had actually succeeded.

**Investigation.** No hypothesis was formed first. `DNS_PROBE_FINISHED_NXDOMAIN` reads
like the application itself is down, so the initial assumption was that something in the
app had broken. That was the actual dead end: time spent looking at the app itself, when
nothing was wrong with it. What identified the real cause was noticing the host in the
browser's own address bar — it was the tunnel's `trycloudflare.com` hostname, not
`localhost`, which meant Flutterwave had been handed the tunnel as the return URL in the
first place. The tunnel process had since died, taking that hostname's DNS with it.

**Cause.** `APP_BASE_URL` — the variable used to build Flutterwave's `redirect_url` at
checkout initiation (`app/api/checkout/route.ts:94`) — had been set to the cloudflared
tunnel's `https://*.trycloudflare.com` URL instead of `http://localhost:3000`. The
tunnel URL belongs in exactly one place — the Flutterwave dashboard's own
**Webhooks → URL** field — never in `APP_BASE_URL`, which this application uses to build
a URL it hands to the *browser*, not to Flutterwave's own outbound webhook delivery.

**Why this was recoverable at all.** Recovery was pasting the same query string onto
`http://localhost:3000/checkout/return` by hand — it verified and granted on the first
attempt. That works because the return view reads only `tx_ref` and `transaction_id`
from the URL, then calls Flutterwave's verify endpoint server-side
(`GET /v3/transactions/{id}/verify`); nothing about which *origin* the browser arrived
from is trusted or even consulted. The payment was therefore recoverable from any
origin at all, given a valid session — the dead tunnel only ever broke one browser
redirect, not the underlying fact of what Flutterwave had already confirmed. Idempotency
on `providerReference` (`granted:{providerTxId}`, Section 5) is what made a second,
manual attempt safe to make at all: replaying the same transaction id could not double-grant
it. If entitlement had instead been granted directly off the redirect's own claimed
`?status=successful` — the brief's named trap — this incident would have been
unrecoverable in the sense that actually matters: the browser would simply never have
arrived to grant anything, whether or not the payment behind it was real.

**Fix.** `APP_BASE_URL` set back to `http://localhost:3000` in `.env`; the tunnel URL
used only for the Flutterwave dashboard's webhook field, documented as such in Section 2
of this file so the mistake is not repeated.

### Problem 2 — Tailwind generated no CSS at all

**Symptom.** Every page rendered as unstyled HTML — no colours, no spacing, no layout —
despite `className` attributes being present throughout the markup.

**Investigation.** Content paths were suspected first: in Tailwind v3, a
misconfigured or missing `content` array in `tailwind.config.js` is the classic cause of
"utilities exist in the stylesheet but don't cover the files that use them." That dead
end went nowhere because this project is on Tailwind v4, which has no such
configuration file at all by default — `tailwind.config.js` does not exist in this
repository, and content detection in v4 is automatic.

**Cause.** `app/globals.css` never contained the line `@import "tailwindcss";` — v4's
actual entry point, which the PostCSS plugin (`@tailwindcss/postcss`, wired correctly in
`postcss.config.mjs`) expands into every utility rule. Without it, there was nothing for
the plugin to expand at all: `postcss.config.mjs` was correct, `package.json`'s
dependencies were correct, only the one import line was missing, since scaffolding.

**Fix.** Added `@import "tailwindcss";` to the top of `app/globals.css`. Confirmed
against a running server by fetching the actual served CSS bundle (not just rebuilding
and hoping) and checking for the presence of the theme layer's `--spacing` variable and
the utilities layer's generated rules.

### Problem 3 — spacing utilities still dead after that fix

**Symptom.** After Problem 2's fix, colours, borders and CSS grid utilities all worked
correctly, but padding, margins and the gap between elements (e.g. a badge and the
heading beside it) still did not apply anywhere.

**Investigation.** The served CSS bundle was fetched and inspected directly rather than
guessed at. All three of Tailwind's own layers were confirmed present and individually
correct: `@layer theme` carried `--spacing: .25rem` and the full colour/font scale;
`@layer base` carried preflight's own reset; `@layer utilities` carried exactly the
right generated rules, e.g. `.p-6{padding:calc(var(--spacing) * 6)}`. Nothing was
missing — which was itself the clue that this was not a repeat of Problem 2.

**Cause.** `app/globals.css` also contained its own `* { box-sizing: border-box; margin:
0; padding: 0; }`, scaffolded before Tailwind was ever wired in and left in place by
Problem 2's fix (which only added the missing `@import`). That rule sits outside any
`@layer` block. Per the CSS Cascade Layers specification, an **unlayered declaration
always wins over a layered one, regardless of selector specificity or source order** —
Tailwind's own utilities live inside `@layer utilities`, so this legacy rule was
unconditionally overriding every utility that set `margin` or `padding`, no matter how
specific or how late in the file those utilities were generated. The split in symptoms
is the actual diagnostic signature of this exact bug: the legacy rule only ever touched
`box-sizing`, `margin` and `padding` — it said nothing about `border-color`,
`background-color`, or `display: grid`, so utilities in those categories were never in
its way and worked from the moment Problem 2 was fixed.

**Fix.** Removed the rule. Tailwind's own preflight (already active, in `@layer base`)
provides an equivalent reset — more completely, in fact, since it also covers
`::before`/`::after`/`::backdrop`/`::file-selector-button` — so nothing was lost, and
utilities (a later, higher-priority layer within Tailwind's own three) now correctly
override it as designed. Confirmed by refetching the compiled bundle afterward and
checking that no unlayered rule remained to out-rank `.p-6`, `.mx-auto` or `.ml-2`.

### Problem 4 — a PAYMENT_FAILED row after a successful grant

**Symptom.** The real payment log contained a `PAYMENT_FAILED` row (seq 180) roughly two
and a half minutes after a successful `ENTITLEMENT_GRANTED` (seq 179) for the same
`tx_ref` — a row that, read in isolation, says a payment failed when it had not.

**Investigation.** The first, and worse, possibility was checked and ruled out directly
against the log rather than assumed: had `ENTITLEMENT_GRANTED` (seq 179) been written
*without* a preceding `PAYMENT_VERIFIED` for the same `providerReference` — the brief's
worst-named trap? It had not. Querying the log by `seq` showed `PAYMENT_VERIFIED` (seq
178) and `ENTITLEMENT_GRANTED` (seq 179) sharing the identical `providerReference`
(`10480488`), written back-to-back at the same timestamp, exactly as `fulfilCheckout`
produces them in one call. The grant was sound.

**Cause.** `fulfilCheckout` had no short-circuit for "this `transaction_id` was already
granted" before it called Flutterwave's verify endpoint again. The webhook and the
return view are two independent triggers for the same code path
(`app/api/webhooks/flutterwave/route.ts` and `app/checkout/return/page.tsx`), and
whichever one arrives *second*, for a transaction the other has already fulfilled,
still re-ran the full verification call. On this occasion that redundant, second call to
Flutterwave itself failed transiently (`reason: "Verify call did not succeed:
provider_error"`) — a real defect, but not the one it looked like: the payment had not
failed; a *redundant re-check* of an already-successful payment had a transient network
problem.

**Fix.** Two parts, both in `lib/fulfilCheckout.ts`. First, a check-then-*call*
short-circuit (line 164): if `ENTITLEMENT_GRANTED` already exists for this
`providerReference`, return `"duplicate"` without calling Flutterwave again at all —
this is explicitly not a substitute for the real idempotency guarantee (the unique
constraint on `granted:{providerTxId}` still is that), only a way to make the redundant
provider call, and therefore this failure mode, rare rather than routine. Second, the
redundant trigger is itself recorded now rather than silently absorbed or mislabelled: a
new event type, `FULFILMENT_DUPLICATE_IGNORED`, following the
`WEBHOOK_DUPLICATE_IGNORED` precedent one level up — a genuine no-op for entitlement
(`lib/entitlement.ts` ignores it entirely in its own switch case), timestamp-suffixed so
a third trigger records its own row rather than colliding with the second's. The
original defect's own rows (seq 177–180) are on the earlier account, not in the
evidence screenshots directly — read via the queries in Section 3's dispute answer. The
fix working, organically, on a genuine repeat page visit is what
`20-full-lifecycle-log.png` actually shows: a `FULFILMENT_DUPLICATE_IGNORED` row sitting
between the monthly subscribe and the yearly upgrade quote, recording a real second
fulfilment trigger that this fix caught before it could call Flutterwave again.

## Section 7: What This Slice Does Not Handle

**Left out because it is outside the brief:**
- No refunds, no reactivation control, no dunning/retry for failed recurring charges, no
  invoices, and no proration on a downgrade. None of these are named as required, and
  each would need its own event type, derivation case, and endpoint (see Section 5,
  Cancellation, for the reactivation case specifically).

**Left out, or left thin, for reasons worth stating honestly:**
- **The webhook has never fired during a real end-to-end payment.** Both payments in the
  evidence walkthrough used for screenshots 11 through 20 (subscribe, then upgrade) were
  fulfilled by the return view — neither log shows a `WEBHOOK_RECEIVED` row at all. The
  webhook code path is real and does work (`app/api/webhooks/flutterwave/route.ts`,
  exercised by `app/api/webhooks/flutterwave/route.test.ts`), but the duplicate-webhook
  evidence (`08-duplicate-webhook-recorded-once-acted-once.jpg`) comes from a
  deliberately fired delivery during earlier, separate testing, not from this
  documentation's own subscribe-and-upgrade run.
- **Evidence in this documentation comes from two real accounts, for a concrete reason,
  not noise avoidance.** The earlier build evidence (steps 7 through 10 — the return
  view, the webhook, the first upgrade and downgrade screenshots) is on one account,
  whose log runs from `seq` 71 to 1016 across 9–10 September. By the time the later
  screenshots were needed, that account already had an active yearly subscription with a
  downgrade pending — no free-plan state left to show. Demonstrating the plans view as a
  free user, the subscribe flow, and the before-upgrade subscription state
  (`12-subscription-before-upgrade.png`) all require an account that has not subscribed
  yet, which the first account no longer was. The complete subscribe → upgrade →
  downgrade → cancel walkthrough for screenshots 11 through 20 is therefore on a second,
  fresh account instead, whose log runs from `seq` 3241 to 5020 on 11 and 13 September.
- **A `PAYMENT_VERIFIED` row with no following grant is ambiguous.** It could mean
  fulfilment is still mid-flight (about to write `ENTITLEMENT_GRANTED` in the same call
  that already committed the verification), or it could mean a genuinely inconsistent
  prior log caused `fulfilCheckout` to refuse to grant (the `"needs_review"` outcome —
  Section 6, Problem 4's aftermath). No event type distinguishes these two cases from
  each other by reading the row alone; telling them apart today means re-deriving the
  full log and checking whether it comes back `"inconsistent"`.
- **The stale-upgrade-quote path (`confirmUpgrade`'s `"stale"` outcome) and the
  lapsed-downgrade path (`scheduleDowngrade`'s `"no_active_paid_plan"` outcome reached
  after a period that *was* active has since ended, rather than one that never existed)
  are code-read only.** Both are exercised by existing tests only for the adjacent case
  (no active period at all, ever) — not for the specific timing race each name describes
  — and hand-verified by reading the code path rather than by a dedicated test.
- **The checkout return view (`app/checkout/return/page.tsx`) sits outside the
  `app/(app)` route group**, so it has no shared layout, no navigation, and none of the
  Tailwind-driven styling the rest of the signed-in shell has — it renders plain,
  unstyled `<main><p>` content. This was a deliberate scope boundary when the shell was
  built, not an oversight discovered late, but it does mean this one page looks
  noticeably different from every other page a signed-in user sees.

## Section 8: If I Built This Again

I would write the period arithmetic down in full before writing any code that produces
a period. The anchor rule — that a billing day comes from the first payment of a run
rather than from whatever the current period end happens to hold — arrived as a
correction after the write path already existed, and then needed two further
corrections: once when it turned out to produce a 46-day month across a lapse and
restart, and again when the fix changed what happens on a plan change. Each round was
cheap on its own, but the log is append-only, so any period written under a wrong rule
is a row I cannot go back and edit. Derivation faithfully replays what was recorded,
which means the write path is the only place this arithmetic can be right, and it gets
one attempt per payment. Everything else in this slice was recoverable by appending
another event. Periods were not, and that is the part I should have specified first.
