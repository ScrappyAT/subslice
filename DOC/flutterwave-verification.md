# Flutterwave documentation verification

Verification completed 8 September 2026, before any integration code was written,
per AGENTS.md's "verify before you build" step. Findings below, with a link to
the page each answer came from. Where the documentation was ambiguous or
contradictory, that is stated plainly rather than resolved by guessing.

## 1. API version and base URL

**Finding, not clean:** Flutterwave currently maintains **two live, actively-supported
API versions side by side** — v3 and v4 — with different base URLs, different
request/response shapes, and different auth models. Nothing decides between them
from the documentation alone.

- **v3** — base URL `https://api.flutterwave.com/v3`. Confirmed not deprecated:
  "we have no immediate plans to deprecate v3. It will continue to be supported,
  and we'll provide ample notice before any deprecation happens." —
  [developer.flutterwave.com](https://developer.flutterwave.com/)
- **v4** — the docs portal now defaults to v4 and calls it the recommended
  version ("cleaner structure, better error handling, improved security
  features"). Base URL(s) found were inconsistent across pages: one v4 guide
  uses `https://developersandbox-api.flutterwave.com` for creating a charge and
  `https://api-sit.flutterwave.cloud/developersandbox` for retrieving one —
  [How to Collect Payments Using the v4 APIs](https://dev.to/flutterwaveeng/how-to-collect-payments-using-the-v4-apis-4lhp).
  Could not resolve why those hostnames differ from primary docs — left as
  unconfirmed rather than treated as fact.
- Docs explicitly warn "you can only use one version" — v3 and v4 can't be
  mixed in one integration. — [developer.flutterwave.com](https://developer.flutterwave.com/)

## 2. Initiating a payment in test mode

- **v3**: `POST https://api.flutterwave.com/v3/payments`, body includes
  `tx_ref`, `amount`, `currency`, `redirect_url`, `customer{email,...}`,
  `payment_options`, etc. Redirect-based checkout (customer sent to a hosted
  Flutterwave page, then returned to `redirect_url`). —
  [Flutterwave Standard docs](https://developer.flutterwave.com/v3.0/docs/flutterwave-standard-1)
- **v4**: `POST /charges` (host per the caveat above), body requires a
  pre-created `customer_id` and `payment_method_id`, plus `reference`,
  `currency`, `amount`, `redirect_url`. Fundamentally different flow — assumes
  customer and payment-method objects already exist server-side before you
  charge, not a single-shot redirect. —
  [A-Z of Card Payments with Flutterwave v4](https://dev.to/flutterwaveeng/a-z-of-card-payments-with-flutterwave-v4-145e),
  [How to Collect Payments Using the v4 APIs](https://dev.to/flutterwaveeng/how-to-collect-payments-using-the-v4-apis-4lhp)

## 3. Server-side transaction verification endpoint

- **v3**: `GET https://api.flutterwave.com/v3/transactions/{id}/verify`, where
  `{id}` is the numeric `data.id` from the initiate-payment response or the
  webhook payload. —
  [Verify transaction status](https://developer.flutterwave.com/v3.0/reference/verify-transaction)
- **Could not retrieve the complete response schema** from this page — the
  interactive schema block didn't render in what was fetched. Secondary docs
  say to check that the returned status, `tx_ref`, currency, and amount match
  what's expected, but a verified, complete field list (e.g. whether
  `charged_amount`, `app_fee`, `processor_response` are present) could not be
  confirmed from the documentation. **Unresolved — must be confirmed against a
  live sandbox response, not the docs.**
- **v4**: retrieval is `GET .../charges/{id}` on the sandbox host noted above,
  and the v4 guide says webhook is the *recommended* primary confirmation path,
  with polling the charge endpoint as a fallback — a different emphasis from
  v3's "redirect then verify" pattern. —
  [How to Collect Payments Using the v4 APIs](https://dev.to/flutterwaveeng/how-to-collect-payments-using-the-v4-apis-4lhp)

## 4. Webhook authenticity mechanism — the most important finding

Two different, contradictory current docs pages were found, and this is not
papered over:

- `https://developer.flutterwave.com/v3.0/docs/webhooks` (v3-scoped): header is
  literally **`verif-hash`**, and verification is a **plain equality
  comparison** against the secret hash set in the dashboard — the sample code
  is `if (!signature || (signature !== secretHash)) { res.status(401).end(); }`.
  A shared secret compared for equality, **not a signature.** It does not bind
  the hash to the request body in any way — it protects against someone who
  doesn't know the secret hash hitting the endpoint, but a captured/replayed
  legitimate request would still pass, and it gives no tamper-evidence over the
  payload itself (the header value never changes). —
  [v3.0 Webhooks](https://developer.flutterwave.com/v3.0/docs/webhooks)
- `https://developer.flutterwave.com/docs/webhooks` (unversioned, appears to be
  the v4-era rewrite): header is **`flutterwave-signature`**, and it genuinely
  is **HMAC-SHA256 computed over the webhook body** using the secret hash as
  key, base64-encoded, compared against the computed digest server-side. This
  *is* a real signature — it provides body tamper-evidence, which the v3
  mechanism does not. — [Webhooks](https://developer.flutterwave.com/docs/webhooks)

Could not confirm with certainty which of these applies without knowing which
API version is used — the docs site doesn't clearly label `/docs/webhooks` as
v4-only, but the mechanism described only makes sense alongside the v4 rewrite.
This is exactly the ambiguity flagged rather than guessed at: the security
property is materially different depending on version (plain shared-secret
equality vs. genuine HMAC signature).

## 5. Amount field: major or minor units

- v3 `/v3/payments`: the doc's own example is `"amount": "7500"` for a ₦7,500
  charge — i.e. **major units** (a string, not minor/kobo). —
  [Flutterwave Standard docs](https://developer.flutterwave.com/v3.0/docs/flutterwave-standard-1)
- v4 charges examples show `"amount": 250` and, in a related guide, `1234.56`
  — the decimal example only makes sense as **major units** too. Neither v4
  page states this explicitly in words — inferred from example values, not a
  stated rule.
- On both versions, everything found points to **major units**, contradicting
  one AI-generated search summary that claimed v3 used minor units — that
  summary did not match what the actual docs page said when fetched directly,
  so it was discarded.

## 6. Test cards / test mode

- **v3** has a fixed set of test card numbers with specific PIN/OTP
  combinations for different auth flows (PIN, 3DS, AVS, no-auth) and specific
  failure cards (insufficient funds, do-not-honour, card fraudulent, incorrect
  PIN), plus test bank accounts and mobile-money numbers with fixed OTPs. —
  [Testing docs](https://developer.flutterwave.com/v3.0/docs/testing)
- **v4** replaces (or supplements — unclear) this with a **scenario-key
  mechanism**: pass `scenario:<value>&issuer:<value>` via an `X-Scenario-Key`
  header to simulate outcomes, rather than relying primarily on distinct card
  numbers. Could not get the concrete list of scenario values/issuers from
  what was fetched. —
  [A-Z of Card Payments with Flutterwave v4](https://dev.to/flutterwaveeng/a-z-of-card-payments-with-flutterwave-v4-145e)
- **Unresolved — must be confirmed against a live sandbox**, not the docs,
  before the error-handling pass depends on the v3 test card list working as
  documented.

## Architectural decisions affected (as originally assessed)

- **Idempotency is keyed on the provider reference** — directly affected. v3
  exposes `tx_ref` (ours) and `id`/`flw_ref` (theirs) as candidate reference
  fields on the same transaction; v4's charge model uses `reference` plus
  separate `customer_id`/`payment_method_id` objects. Which field gets the
  unique constraint depends on which version and which field is chosen.
- **Webhook endpoint, authenticity check** — the mechanism is only "a shared
  secret compared for equality" if the integration ends up on v3. On v4 it's a
  real HMAC-SHA256 signature with different protection properties.
- **Entitlement is granted only after server-side verification** — affected in
  shape, not principle: v3's verify-then-write flow matches a redirect-return
  pattern; v4 leans on the webhook as primary confirmation with the
  charge-status GET as fallback — a different sequencing of the same rule.
- **Money is stored as integers in minor units... convert at the provider
  boundary** — confirmed as the active case: everything found points to
  Flutterwave (both versions) expecting major/decimal units, so the "convert
  at the boundary" clause is the one that fires.
- **Checkout initiation endpoint** — potentially affected in scope: v3 is a
  single-call redirect; v4 requires creating `customer` and `payment_method`
  resources before charging, more integration surface than a single endpoint.

## Resolution

The API version question was subsequently settled in AGENTS.md: **Flutterwave
API v3, pinned.** v4 was rejected specifically because its charge flow
requires a server-created payment-method object, which risks a card number
reaching the server and breaking the hard rule that card data never touches
this application. The webhook mechanism is therefore the v3 one: a shared-secret
equality check on `verif-hash`, not a signature — confirmed, not merely assumed,
by this report's finding 4 above.

The two items marked unresolved above (the complete verify-response field
list, and the v3 test card list) were confirmed against a live sandbox
response during step 7 — see the `PaymentEvent.payload` of a real
`PAYMENT_VERIFIED` row for the actual shape Flutterwave returns.
