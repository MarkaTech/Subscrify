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
  | "DEAD_LETTERED";

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
 * apply to a row that isn't still in flight.
 */
export async function markSucceeded(
  db: PrismaClient,
  idempotencyKey: string,
  params: { shopifyBillingAttemptGid?: string | null },
): Promise<{ applied: boolean }> {
  const result = await db.billingCycleAttempt.updateMany({
    where: { idempotencyKey, status: { in: ["ENQUEUED", "CHARGING"] } },
    data: {
      status: "SUCCEEDED",
      shopifyBillingAttemptGid: params.shopifyBillingAttemptGid ?? undefined,
      completedAt: new Date(),
    },
  });
  return { applied: result.count > 0 };
}

export async function findByIdempotencyKey(db: PrismaClient, idempotencyKey: string) {
  return db.billingCycleAttempt.findUnique({ where: { idempotencyKey } });
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
