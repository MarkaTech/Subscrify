/**
 * Local persistence for billing attempts (Phase 4 billing engine).
 *
 * This is the local half of invariant #1 (never overbill): idempotencyKey is
 * unique in the schema, so enqueueAttempt's insert fails — and is treated as
 * a safe no-op — for any key that's already been recorded, whether that's a
 * duplicate scheduler tick, a redelivered Service Bus message, or a
 * duplicate webhook. This wall exists alongside, not instead of, Service
 * Bus's own duplicate detection and Shopify's idempotencyKey on the charge
 * mutation — any one of the three stopping a duplicate is enough.
 *
 * Every function takes `shop` explicitly and filters on it (invariant #2).
 */

import type { PrismaClient } from "@prisma/client";

export type BillingAttemptStatus =
  | "ENQUEUED"
  | "CHARGING"
  | "SUCCEEDED"
  | "FAILED"
  | "REQUIRES_ACTION"
  | "DEAD_LETTERED"
  | "SKIPPED";

/**
 * Explicit shape of a BillingCycleAttempt row, mirrored from
 * prisma/schema.prisma. Declared by hand (rather than relying on inference
 * from the generated Prisma Client) so callers like the contract detail
 * route get real field types even in an environment where `prisma generate`
 * hasn't run against this schema yet — see the sandbox note in
 * claude/subscrify-status.md. Keep this in sync with the model.
 */
export interface BillingAttemptRecord {
  id: string;
  shop: string;
  subscriptionContractGid: string;
  billingCycleIndex: number;
  attemptNumber: number;
  idempotencyKey: string;
  status: string;
  shopifyBillingAttemptGid: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  nextRetryAt: Date | null;
  enqueuedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnqueueAttemptParams {
  shop: string;
  subscriptionContractGid: string;
  billingCycleIndex: number;
  attemptNumber: number;
  idempotencyKey: string;
}

/**
 * Record a new billing attempt as ENQUEUED. Returns created:false (not an
 * error) if this exact idempotency key already has a row — that's invariant
 * #1 doing its job, not a bug.
 */
export async function enqueueAttempt(
  db: PrismaClient,
  params: EnqueueAttemptParams,
): Promise<{ created: boolean }> {
  try {
    await db.billingCycleAttempt.create({
      data: {
        shop: params.shop,
        subscriptionContractGid: params.subscriptionContractGid,
        billingCycleIndex: params.billingCycleIndex,
        attemptNumber: params.attemptNumber,
        idempotencyKey: params.idempotencyKey,
        status: "ENQUEUED",
      },
    });
    return { created: true };
  } catch (e: any) {
    if (e?.code === "P2002") return { created: false };
    throw e;
  }
}

export async function markCharging(db: PrismaClient, idempotencyKey: string) {
  await db.billingCycleAttempt.updateMany({
    where: { idempotencyKey, status: "ENQUEUED" },
    data: { status: "CHARGING" },
  });
}

/**
 * Attach the Shopify billing attempt GID once the charge mutation has been
 * accepted (async — the final outcome arrives later via webhook).
 */
export async function attachShopifyAttempt(
  db: PrismaClient,
  idempotencyKey: string,
  shopifyBillingAttemptGid: string,
) {
  await db.billingCycleAttempt.updateMany({
    where: { idempotencyKey },
    data: { shopifyBillingAttemptGid },
  });
}

/**
 * Terminal or retryable failure. Guarded to only transition from
 * ENQUEUED/CHARGING — a stray/duplicate failure signal can never downgrade a
 * row that's already SUCCEEDED. Returns whether the guard actually applied
 * (false means this was a no-op — log it, don't treat it as an error).
 */
export async function markFailed(
  db: PrismaClient,
  idempotencyKey: string,
  params: {
    errorCode?: string | null;
    errorMessage?: string | null;
    nextRetryAt?: Date | null;
    requiresAction?: boolean;
  },
): Promise<{ applied: boolean }> {
  const result = await db.billingCycleAttempt.updateMany({
    where: { idempotencyKey, status: { in: ["ENQUEUED", "CHARGING"] } },
    data: {
      status: params.requiresAction ? "REQUIRES_ACTION" : "FAILED",
      errorCode: params.errorCode ?? null,
      errorMessage: params.errorMessage ?? null,
      nextRetryAt: params.nextRetryAt ?? null,
      completedAt: new Date(),
    },
  });
  return { applied: result.count > 0 };
}

/**
 * Guarded the same way as markFailed — a stray success signal can never
 * apply to a row that's already terminal (SUCCEEDED/FAILED/SKIPPED).
 *
 * REQUIRES_ACTION is deliberately included alongside ENQUEUED/CHARGING: a
 * 3-D Secure challenge that gets resolved arrives as a `success` webhook for
 * an attempt that's currently sitting in REQUIRES_ACTION, not ENQUEUED or
 * CHARGING. Before this included REQUIRES_ACTION, that success webhook was a
 * silent no-op — the original attempt never got marked SUCCEEDED, and the
 * dunning retry scheduled the moment the challenge was issued (see
 * webhook-handler.server.ts) went on to fire days later regardless,
 * double-charging the customer. See hasSucceededAttemptForCycle for the
 * other half of that fix: the retry itself also has to check before it
 * charges.
 */
export async function markSucceeded(
  db: PrismaClient,
  idempotencyKey: string,
  params: { shopifyBillingAttemptGid?: string | null },
): Promise<{ applied: boolean }> {
  const result = await db.billingCycleAttempt.updateMany({
    where: { idempotencyKey, status: { in: ["ENQUEUED", "CHARGING", "REQUIRES_ACTION"] } },
    data: {
      status: "SUCCEEDED",
      shopifyBillingAttemptGid: params.shopifyBillingAttemptGid ?? undefined,
      completedAt: new Date(),
    },
  });
  return { applied: result.count > 0 };
}

/**
 * Mark a row SKIPPED without ever calling Shopify — used when a scheduled
 * dunning retry is about to fire but the cycle it targets already succeeded
 * under a different attempt (see hasSucceededAttemptForCycle). Distinct from
 * FAILED so the billing-history UI never shows a declined-looking badge for
 * a cycle that was, in fact, paid.
 */
export async function markSkipped(
  db: PrismaClient,
  idempotencyKey: string,
  params: { errorCode?: string | null; errorMessage?: string | null },
): Promise<{ applied: boolean }> {
  const result = await db.billingCycleAttempt.updateMany({
    where: { idempotencyKey, status: { in: ["ENQUEUED", "CHARGING"] } },
    data: {
      status: "SKIPPED",
      errorCode: params.errorCode ?? null,
      errorMessage: params.errorMessage ?? null,
      completedAt: new Date(),
    },
  });
  return { applied: result.count > 0 };
}

export async function findByIdempotencyKey(db: PrismaClient, idempotencyKey: string) {
  return db.billingCycleAttempt.findUnique({ where: { idempotencyKey } });
}

/**
 * True if this contract-cycle already has a SUCCEEDED attempt, under any
 * attempt number. A scheduled dunning retry calls this immediately before
 * charging: if a 3-D Secure challenge on an earlier attempt resolved
 * successfully after the retry was already enqueued, this stops the retry
 * from charging the same cycle a second time. This is invariant #1 (never
 * overbill)'s last line of defense for that race — see markSucceeded.
 */
export async function hasSucceededAttemptForCycle(
  db: PrismaClient,
  shop: string,
  subscriptionContractGid: string,
  billingCycleIndex: number,
): Promise<boolean> {
  const existing = await db.billingCycleAttempt.findFirst({
    where: { shop, subscriptionContractGid, billingCycleIndex, status: "SUCCEEDED" },
    select: { id: true },
  });
  return existing !== null;
}

/** Recent billing attempts for one contract — for the admin's "billing history" view. */
export async function listAttemptsForContract(
  db: PrismaClient,
  shop: string,
  subscriptionContractGid: string,
): Promise<BillingAttemptRecord[]> {
  return db.billingCycleAttempt.findMany({
    where: { shop, subscriptionContractGid },
    orderBy: [{ billingCycleIndex: "desc" }, { attemptNumber: "desc" }],
    take: 20,
  });
}

/** All distinct shops with an installed (offline) session — the scheduler's shop list. */
export async function listInstalledShops(db: PrismaClient): Promise<string[]> {
  const rows: Array<{ shop: string }> = await db.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });
  return rows.map((r: { shop: string }) => r.shop);
}
