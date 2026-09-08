-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('NONE', 'MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "PaymentEventType" AS ENUM ('CHECKOUT_INITIATED', 'PRORATION_QUOTED', 'PAYMENT_VERIFIED', 'ENTITLEMENT_GRANTED', 'PAYMENT_FAILED', 'WEBHOOK_RECEIVED', 'WEBHOOK_DUPLICATE_IGNORED', 'DOWNGRADE_SCHEDULED', 'CANCELLATION_REQUESTED', 'CANCELLATION_REASON_PROVIDED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'CANCELLING', 'EXPIRED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" CHAR(6) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitHit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimitHit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "PaymentEventType" NOT NULL,
    "planCode" TEXT,
    "txRef" TEXT,
    "providerReference" TEXT,
    "amountMinor" INTEGER,
    "currency" CHAR(3),
    "creditAppliedMinor" INTEGER,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "reason" TEXT,
    "payload" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planCode" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "pendingPlanCode" TEXT,
    "lastEventSeq" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "VerificationCode_userId_createdAt_idx" ON "VerificationCode"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "RateLimitHit_key_createdAt_idx" ON "RateLimitHit"("key", "createdAt");

-- CreateIndex
CREATE INDEX "Plan_active_idx" ON "Plan"("active");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEvent_seq_key" ON "PaymentEvent"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEvent_idempotencyKey_key" ON "PaymentEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PaymentEvent_userId_seq_idx" ON "PaymentEvent"("userId", "seq");

-- CreateIndex
CREATE INDEX "PaymentEvent_txRef_idx" ON "PaymentEvent"("txRef");

-- CreateIndex
CREATE INDEX "PaymentEvent_providerReference_idx" ON "PaymentEvent"("providerReference");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");

-- CreateIndex
CREATE INDEX "Subscription_currentPeriodEnd_idx" ON "Subscription"("currentPeriodEnd");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationCode" ADD CONSTRAINT "VerificationCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_planCode_fkey" FOREIGN KEY ("planCode") REFERENCES "Plan"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planCode_fkey" FOREIGN KEY ("planCode") REFERENCES "Plan"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_pendingPlanCode_fkey" FOREIGN KEY ("pendingPlanCode") REFERENCES "Plan"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraint
-- Prevents: a plan priced negative, e.g. a typo entering -500 as a price.
-- amountMinor is a price here, never null, so no null-handling needed.
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_amountMinor_nonnegative" CHECK ("amountMinor" >= 0);

-- CheckConstraint
-- Prevents: a currency code that isn't three uppercase letters — lowercase,
-- wrong length, or digits. Catches a typo or a non-ISO-4217 value at the
-- source of the plan's price rather than downstream.
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$');

-- CheckConstraint
-- Prevents: a payment event recording a negative amount, e.g. a sign error
-- turning a refund-shaped calculation into a negative charge. amountMinor is
-- nullable here (events that move no money, such as CHECKOUT_INITIATED,
-- leave it null), so the constraint only fires when a value is present.
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_amountMinor_nonnegative" CHECK ("amountMinor" IS NULL OR "amountMinor" >= 0);

-- CheckConstraint
-- Prevents: an amount recorded with no currency, or a currency recorded with
-- no amount — the actual reason currency lives on PaymentEvent at all. An
-- amountMinor without a currency is ambiguous (2500 of what?) and a currency
-- with no amount records nothing.
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_amount_currency_pair" CHECK (("amountMinor" IS NULL AND "currency" IS NULL) OR ("amountMinor" IS NOT NULL AND "currency" IS NOT NULL));

-- CheckConstraint
-- Prevents: the same malformed-currency-code problem as Plan_currency_iso,
-- on the event row instead of the plan row. Nullable, so events that record
-- no amount are unaffected.
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_currency_iso" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$');

-- CheckConstraint
-- Prevents: a proration credit that is itself negative — a credit is a
-- reduction in what's owed, and a negative one would increase it instead,
-- silently reversing the "rounding is in the customer's favour" rule.
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_credit_nonnegative" CHECK ("creditAppliedMinor" IS NULL OR "creditAppliedMinor" >= 0);

-- CheckConstraint
-- Prevents: a period with only one boundary recorded, or one where the end
-- is not after the start, on any event that establishes a period.
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_period_pair" CHECK (("periodStart" IS NULL AND "periodEnd" IS NULL) OR ("periodStart" IS NOT NULL AND "periodEnd" IS NOT NULL AND "periodEnd" > "periodStart"));

-- CheckConstraint
-- The important one: prevents an ENTITLEMENT_GRANTED event that grants
-- access to nothing, for no time — planCode, periodStart, periodEnd,
-- amountMinor and currency must all be present together whenever the event
-- type is ENTITLEMENT_GRANTED. Every other event type is unconstrained by
-- this check.
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_grant_complete" CHECK ("type" <> 'ENTITLEMENT_GRANTED' OR ("planCode" IS NOT NULL AND "periodStart" IS NOT NULL AND "periodEnd" IS NOT NULL AND "amountMinor" IS NOT NULL AND "currency" IS NOT NULL));

-- Seed the three sellable plans. Seeded here, not at runtime, so the
-- database is never in a state where a plan code referenced by a foreign
-- key does not exist. Prices are illustrative test-mode NGN amounts in
-- minor units (kobo); yearly is priced at 10x monthly, i.e. two months free.
INSERT INTO "Plan" ("code", "name", "amountMinor", "currency", "interval", "active") VALUES
    ('free', 'Free', 0, 'NGN', 'NONE', true),
    ('monthly', 'Monthly', 250000, 'NGN', 'MONTH', true),
    ('yearly', 'Yearly', 2500000, 'NGN', 'YEAR', true);

