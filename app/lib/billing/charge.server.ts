/**
 * Charge processing + failure recovery — Phase 4 billing engine.
 *
 * planFailureRecovery is the pure decision (given a failure/challenge
 * outcome, what should happen — unit tested in charge.test.ts).
 * applyFailureRecovery and processBillingAttemptMessage are the impure
 * executors that turn that decision into DB writes and a queue send; like
 * the rest of this app's *.server.ts glue (contracts/api.server.ts,
 * selling-plans/api.server.ts), they're exercised through the running app
 * rather than unit tested directly.
 */

import type { PrismaClient } from "@prisma/client";
import type { AdminClient } from "../selling-plans/api.server";
import { billingRetryIdempotencyKey, type BillingCycleRef } from "./idempotency.server";
import { decideDunning, isRetryableMutationError } from "./dunning.server";
import { chargeBillingCycle, fetchContractStatus } from "./queries.server";
import { isBillableStatus } from "./scheduler.server";
import {
  attachShopifyAttempt,
  enqueueAttempt,
  findByIdempotencyKey,
  hasSucceededAttemptForCycle,
  markCharging,
  markFailed,
  markSkipped,
} from "./store.server";
import { sendBillingAttemptMessage, type BillingAttemptMessage } from "./queue.server";

export interface FailureContext {
  shop: string;
  subscriptionContractGid: string;
  billingCycleIndex: number;
  attemptNumber: number;
  idempotencyKey: string;
}

export interface FailureOutcome {
  errorCode: string | null;
  errorMessage: string | null;
  /** 3-D Secure challenge, unresolved — distinct local status, same dunning treatment. */
  requiresAction: boolean;
  /** Whether this class of failure is worth retrying at all (see dunning.server.ts). */
  retryable: boolean;
}

export interface FailureRecoveryPlan {
  markFailed: {
    errorCode: string | null;
    errorMessage: string | null;
    requiresAction: boolean;
    nextRetryAt: Date | null;
  };
  retry: null | {
    attemptNumber: number;
    idempotencyKey: string;
    scheduledEnqueueTimeUtc: Date;
  };
}

/** Pure: given a failure and "now," decide the full recovery plan. */
export function planFailureRecovery(
  ctx: FailureContext,
  outcome: FailureOutcome,
  now: Date,
): FailureRecoveryPlan {
  const decision = outcome.retryable
    ? decideDunning(ctx.attemptNumber, now)
    : ({ action: "GIVE_UP" } as const);

  if (decision.action !== "RETRY") {
    return {
      markFailed: {
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
        requiresAction: outcome.requiresAction,
        nextRetryAt: null,
      },
      retry: null,
    };
  }

  const ref: BillingCycleRef = {
    shop: ctx.shop,
    subscriptionContractGid: ctx.subscriptionContractGid,
    billingCycleIndex: ctx.billingCycleIndex,
  };
  const retryKey = billingRetryIdempotencyKey(ref, decision.nextAttemptNumber);

  return {
    markFailed: {
      errorCode: outcome.errorCode,
      errorMessage: outcome.errorMessage,
      requiresAction: outcome.requiresAction,
      nextRetryAt: decision.nextRetryAt,
    },
    retry: {
      attemptNumber: decision.nextAttemptNumber,
      idempotencyKey: retryKey,
      scheduledEnqueueTimeUtc: decision.nextRetryAt,
    },
  };
}

/**
 * Apply a recovery plan: mark the failed row, and — if the plan calls for a
 * retry — enqueue the next attempt. enqueueAttempt's own idempotency-key
 * uniqueness means a duplicate signal for the same failure (e.g. Shopify
 * redelivering the same webhook) can safely call this twice: the second
 * enqueue is a no-op and no second message is sent.
 */
export async function applyFailureRecovery(
  db: PrismaClient,
  ctx: FailureContext,
  plan: FailureRecoveryPlan,
): Promise<void> {
  await markFailed(db, ctx.idempotencyKey, plan.markFailed);
  if (!plan.retry) return;

  const { created } = await enqueueAttempt(db, {
    shop: ctx.shop,
    subscriptionContractGid: ctx.subscriptionContractGid,
    billingCycleIndex: ctx.billingCycleIndex,
    attemptNumber: plan.retry.attemptNumber,
    idempotencyKey: plan.retry.idempotencyKey,
  });
  if (!created) return;

  await sendBillingAttemptMessage(
    {
      shop: ctx.shop,
      subscriptionContractGid: ctx.subscriptionContractGid,
      billingCycleIndex: ctx.billingCycleIndex,
      attemptNumber: plan.retry.attemptNumber,
      idempotencyKey: plan.retry.idempotencyKey,
    },
    { scheduledEnqueueTimeUtc: plan.retry.scheduledEnqueueTimeUtc },
  );
}

/**
 * The worker's per-message handler: fire the charge mutation and either
 * record the async-pending state (result arrives later via webhook) or, for
 * a synchronous rejection from the mutation call itself, run the same
 * failure-recovery path webhooks use.
 */
export async function processBillingAttemptMessage(
  message: BillingAttemptMessage,
  deps: { db: PrismaClient; admin: AdminClient; now: () => Date },
): Promise<void> {
  const { db, admin, now } = deps;

  const row = await findByIdempotencyKey(db, message.idempotencyKey);
  if (!row) {
    // No local record for a message we're about to charge against — refuse
    // to charge blind. Throwing here abandons the message (Service Bus
    // redelivers, then dead-letters — the DLQ alert is the safety net for
    // an anomaly like this, not a silent skip).
    throw new Error(
      `no local BillingCycleAttempt row for idempotency key "${message.idempotencyKey}"`,
    );
  }
  if (row.status !== "ENQUEUED") {
    // Redelivery of a message we've already acted on — no-op, not an error.
    return;
  }

  // A dunning retry can be scheduled days in advance (see dunning.server.ts).
  // If the attempt it's retrying was a 3-D Secure challenge that later
  // resolved successfully, the cycle is already paid by the time this retry
  // fires — charging again would violate invariant #1. Check the cycle, not
  // just this row, right before charging: this is the guard that closes the
  // 3DS-challenge double-charge gap (see markSucceeded's doc comment).
  if (
    await hasSucceededAttemptForCycle(
      db,
      message.shop,
      message.subscriptionContractGid,
      message.billingCycleIndex,
    )
  ) {
    await markSkipped(db, message.idempotencyKey, {
      errorCode: "CYCLE_ALREADY_SUCCEEDED",
      errorMessage:
        "Billing cycle already succeeded under an earlier attempt (e.g. a delayed 3-D Secure resolution); retry skipped.",
    });
    return;
  }

  // The scheduler's own enqueue is covered (fetchDueContracts filters on
  // status:ACTIVE, re-checked by isContractDue) and so is the manual
  // "bill now" action (forceBillContractNow's explicit status guard) — but a
  // dunning retry can sit scheduled for 3-7 days (see dunning.server.ts)
  // between being enqueued and actually firing here. A customer can cancel
  // or pause in that window; nothing upstream of this point re-checks status
  // at the moment of the actual charge. Re-check live rather than trust the
  // state the contract was in when the retry was scheduled — same standard
  // forceBillContractNow already holds itself to, applied to the one path
  // that was missing it.
  const status = await fetchContractStatus(admin, message.subscriptionContractGid);
  if (!isBillableStatus(status)) {
    await markSkipped(db, message.idempotencyKey, {
      errorCode: "CONTRACT_NOT_BILLABLE",
      errorMessage: `Contract status is ${status ?? "UNKNOWN"} at charge time; retry skipped without charging.`,
    });
    return;
  }

  await markCharging(db, message.idempotencyKey);

  const result = await chargeBillingCycle(admin, {
    contractGid: message.subscriptionContractGid,
    cycleIndex: message.billingCycleIndex,
    idempotencyKey: message.idempotencyKey,
  });

  if (result.userErrors.length > 0) {
    const [firstError] = result.userErrors;
    const code = firstError.code ?? "UNKNOWN";
    const ctx: FailureContext = {
      shop: message.shop,
      subscriptionContractGid: message.subscriptionContractGid,
      billingCycleIndex: message.billingCycleIndex,
      attemptNumber: message.attemptNumber,
      idempotencyKey: message.idempotencyKey,
    };
    const plan = planFailureRecovery(
      ctx,
      {
        errorCode: code,
        errorMessage: firstError.message,
        requiresAction: false,
        retryable: isRetryableMutationError(code),
      },
      now(),
    );
    await applyFailureRecovery(db, ctx, plan);
    return;
  }

  // Mutation accepted — Shopify processes the charge asynchronously. The
  // row stays CHARGING until a subscription_billing_attempts/* webhook
  // (see app/routes/webhooks.subscription_billing_attempts.*.tsx) resolves it.
  if (result.billingAttemptGid) {
    await attachShopifyAttempt(db, message.idempotencyKey, result.billingAttemptGid);
  }
}
