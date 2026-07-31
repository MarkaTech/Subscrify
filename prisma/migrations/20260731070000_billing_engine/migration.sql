-- CreateTable
CREATE TABLE "BillingCycleAttempt" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "subscriptionContractGid" TEXT NOT NULL,
    "billingCycleIndex" INTEGER NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ENQUEUED',
    "shopifyBillingAttemptGid" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "nextRetryAt" TIMESTAMP(3),
    "enqueuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingCycleAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingCycleAttempt_idempotencyKey_key" ON "BillingCycleAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BillingCycleAttempt_shop_idx" ON "BillingCycleAttempt"("shop");

-- CreateIndex
CREATE INDEX "BillingCycleAttempt_status_nextRetryAt_idx" ON "BillingCycleAttempt"("status", "nextRetryAt");

-- CreateIndex
-- Name truncated to Postgres's 63-byte identifier limit (NAMEDATALEN) — this
-- is the exact truncation Postgres/Prisma both produce for the full name
-- "BillingCycleAttempt_shop_subscriptionContractGid_billingCycleIndex_attemptNumber_key";
-- written out explicitly here so `prisma migrate deploy` applies it silently
-- instead of relying on Postgres's own implicit-truncation NOTICE.
CREATE UNIQUE INDEX "BillingCycleAttempt_shop_subscriptionContractGid_billingCycleIn" ON "BillingCycleAttempt"("shop", "subscriptionContractGid", "billingCycleIndex", "attemptNumber");
