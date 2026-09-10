-- AlterTable
ALTER TABLE "PaymentEvent" ALTER COLUMN "reason" SET DATA TYPE VARCHAR(500);

-- AlterTable
ALTER TABLE "Subscription" ALTER COLUMN "cancellationReason" SET DATA TYPE VARCHAR(500);

