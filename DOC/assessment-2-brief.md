# Assessment 2 — The Payment and Subscription Slice

Time budget: 20 to 26 hours. This is the largest of the four.
Deadline: Wednesday 17 September 2026.

## Deliverables

1. A GitHub repository containing the working slice
2. A `DOCUMENTATION.md` at the repository root, eight sections, same structure as Assessment 1
3. A LinkedIn post about what was built and the concepts behind it

The documentation carries as much weight as the code.

## What to build

A working subscription system in test mode, with one paid plan sold on two intervals,
monthly and yearly.

### Screens

- A plans view showing free, monthly and yearly, with the current plan indicated
- A checkout initiation that hands off to the payment provider
- A return view the user lands on after paying
- A billing view showing plan, status, renewal date, and a cancel control
- A minimal signed-in shell to hang these on

### Behaviour

- A user can subscribe to monthly
- A user can upgrade from monthly to yearly mid-cycle, and the amount charged is prorated
- A user can downgrade, with the change applied at the end of the current period
- A user can cancel, and keeps access until the period they paid for ends
- Every payment event is recorded

Reusing the authentication from Assessment 1 is permitted. Say so in the documentation.
Reuse is not cheating; hiding it is.

## Do not build

No landing page. No pricing marketing page. No product features behind the paywall. The
thing being sold is a plan flag on a user record and nothing more.

## Engineering requirements

- Money stored as whole numbers in minor units, with the currency stored alongside
- A payment log table recording every event separately: initiation, verification,
  fulfilment, failure
- Server-side verification before any entitlement is granted, and never on the strength of
  a frontend claim or a redirect alone
- Webhook handling with signature verification before any processing
- Idempotency keyed on the provider reference, so a repeated webhook is recorded once and
  acted on once
- Proration on a mid-cycle interval change, calculated and shown
- Cancellation that retains access to the end of the paid period, with a confirmation step
- A cancellation reason column, populated from an optional post-cancellation prompt
- Rate limiting on the checkout initiation endpoint
- Error handling that never leaves a user on a blank page or a 404, at any point in the
  payment path
- No card details stored anywhere in the system

## Concepts to document in Section 5

- Minor units and why money is never a decimal
- The payment lifecycle of initiation, verification and fulfilment, and why they are three
  separate things
- The payment log and what it would prove in a dispute
- Idempotency in payments
- Webhook signature verification
- Proration, including the actual calculation shown with numbers
- Cancellation and period-end access, including the legal reasoning
- Why cards are not stored, naming PCI scope
- Rate limiting on payment endpoints

## Prove it works

Database evidence is mandatory throughout. Claims without screenshots do not count.

- A screenshot of the subscription record before and after an upgrade, showing the
  interval changed and the period end moved
- A screenshot of the payment log for one complete transaction, showing each stage as its
  own row with timestamps
- The proration calculation written out with real numbers: days remaining, credit applied,
  amount charged, and the ledger or log entries that resulted
- Evidence of firing the same webhook twice, showing the second one recorded and ignored
- A screenshot of a cancelled subscription showing access retained and the period end date

## Grading bands

**Pass:** subscribe, upgrade with proration, downgrade and cancel all work; the payment log
records every stage; entitlement is granted only after server-side verification; database
evidence provided for each.

**Excellent:**
- The payment log is append-only and entitlement is **derived** from it rather than stored
  and mutated
- The duplicate-payment case is tested and handled, meaning paying twice for an active plan
  either extends correctly or is rejected, rather than absorbing the money silently
- The proration calculation is correct to the day and shown

## Traps

- Storing amounts as decimals
- Granting the subscription when the user lands back on the success URL, which means anyone
  who visits that URL directly gets a free subscription
- Cancelling with immediate cutoff after taking payment for the period
- Skipping the payment log because the subscription table already shows a status. The
  status is the present, the log is the history, and the history is what you produce in a
  dispute
- Testing only the happy path and never firing a duplicate webhook

## Defence questions

These will be asked exactly as written.

1. Show me the exact line where entitlement is granted, and tell me what happens if I reach
   that code path directly in my browser.
2. A customer disputes a charge from three months ago. What do you show them, and where does
   it come from?
3. Walk me through your proration arithmetic for an upgrade on day 12 of a 30-day cycle.
4. I pay for yearly twice in one minute. What does your database look like afterwards?

---

# The Documentation Template

Same eight sections as Assessment 1.

**Section 1: What This Is** — two paragraphs. What the slice does, and what is deliberately
excluded and why.

**Section 2: How To Run It** — numbered steps from fresh clone to working local instance.
Environment variables listed by name with where each comes from. Database setup and
migration command. Start command. URL. Include `.env.example`, never commit real keys.

**Section 3: The Flow, Step By Step** — narrative, not a list of endpoints. For each step:
what the user does, what the frontend sends, what the server does with it, and the actual
route or file where it lives.

**Section 4: The Data Model** — every table, one line on what it holds, and the decision
behind each column that carries one. Then answer explicitly: which constraints make an
invalid state impossible?

**Section 5: The Concepts** — the most heavily graded section. Each concept gets its own
subheading and four questions in order: what it is, why it is needed, how I implemented it,
what I chose against and why. No skipping the fourth.

**Section 6: What Went Wrong** — minimum three problems, each with symptom, investigation
including the dead ends, cause, and fix. Do not sanitise.

**Section 7: What This Slice Does Not Handle** — honest limitations. Distinguish what was
left out because it was outside the brief from what was left out because time ran out.

**Section 8: If I Built This Again** — one paragraph, one thing, chosen deliberately.

---

# The LinkedIn Post

200 to 400 words. Open with the problem or the surprise, not a progress update. Name what
you built in one sentence. Teach one concept properly in three or four sentences. Include a
real detail with a number or a specific behaviour. Link the repository.

Avoid: progress updates, lists of technologies, pretending it was easy or hard.

Test: would someone who does not know you learn something from this post?

---

# Submission Checklist

**Repository**
- [ ] Runs from a fresh clone using only the steps in Section 2
- [ ] `.env` is not committed — confirm in a private browser window
- [ ] `.env.example` present with commented placeholders
- [ ] Commit history shows incremental work
- [ ] Nothing outside the brief was built

**Documentation**
- [ ] `DOCUMENTATION.md` at repository root
- [ ] All eight sections present, in order
- [ ] Every required concept has its own subheading in Section 5
- [ ] Every concept answers all four questions
- [ ] Section 6 contains at least three real problems
- [ ] All required evidence screenshots included and readable

**LinkedIn**
- [ ] Posted, with the repository linked
- [ ] Teaches one concept rather than announcing completion
- [ ] Contains at least one specific number or behaviour

**Yourself**
- [ ] You can open any file and explain why it exists
- [ ] You have answered each defence question out loud
