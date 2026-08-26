/**
 * Reconciliation sweep — the billing engine's answer to "what if a webhook
 * never arrives?"
 *
 * The normal path resolves every attempt via subscription_billing_attempts/*
 * webhooks. Webhooks are at-least-once, not guaranteed: if the app is down
 * past Shopify's retry window, or a message dead-letters after markCharging,
 * or the process crashes between markCharging and the mutation call, a row
 * can sit in ENQUEUED/CHARGING forever with nobody noticing. Before this
 * sweep existed that was a silent failure mode (fails safe — undercharge,
 * never overcharge — but a merchant would see a renewal that just never
 * resolved).
 *
 * Every few minutes (called from schedule-loop.server.ts) this sweep:
 *   1. Finds in-flight rows older than STALE_IN_FLIGHT_AFTER_MS, excluding
 *      dunning retries that are simply waiting for their scheduled fire time
 *      (isStaleInFlight — pure, unit tested).
 *   2. For rows that have a Shopify billing-attempt GID, asks Shopify for
 *      the attempt's actual state and applies it through the SAME guarded
 *      transitions the webhooks use — markSucceeded / planFailureRecovery.
 *      Racing a late webhook is safe: both sides go through status-guarded
 *      updates and idempotency-keyed enqueues, so whoever runs second no-ops.
 *   3. For rows with no GID it only WARNS. No GID means the charge mutation
 *      may or may not have reached Shopify, and "probably didn't" is not a
 *      standard this engine charges money on — a human resolves those from
 *      the log line (invariant #1: when in doubt, undercharge).
 */

import type { PrismaClient } from "@prisma/client";
import { unauthenticated } from "../../shopify.server";
import type { AdminClient } from "../selling-plans/api.server";
import { fetchBillingAttemptOutcome } from "./queries.server";
import {
  applyFailureRecovery,
  planFailureRecovery,
  type FailureContext,
} from "./charge.server";
import { listInFlightAttemptsOlderThan, markSucceeded } from "./store.server";
import { STALE_IN_FLIGHT_AFTER_MS, isStaleInFlight } from "./reconcile";

export { STALE_IN_FLIGHT_AFTER_MS, isStaleInFlight };

export interface ReconcileResult {
  checked: number;
  recoveredSucceeded: number;
  recoveredFailed: number;
  stillPending: number;
  unresolvable: number;
  errors: Array<{ idempotencyKey: string; error: string }>;
}

export async function reconcileStaleAttempts(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    checked: 0,
    recoveredSucceeded: 0,
    recoveredFailed: 0,
    stillPending: 0,
    unresolvable: 0,
    errors: [],
  };

  const cutoff = new Date(now.getTime() - STALE_IN_FLIGHT_AFTER_MS);
  const candidates = await listInFlightAttemptsOlderThan(db, cutoff);
  const stale = candidates.filter((row) => isStaleInFlight(row, now));
  if (stale.length === 0) return result;

  // One admin client per shop, reused across that shop's rows.
  const adminByShop = new Map<string, AdminClient>();

  for (const row of stale) {
    result.checked += 1;
    try {
      if (!row.shopifyBillingAttemptGid) {
        result.unresolvable += 1;
        console.warn(
          `[billing-reconciler] STALE ${row.status} row with no Shopify attempt GID — needs manual review. ` +
            `shop=${row.shop} key=${row.idempotencyKey} enqueuedAt=${row.enqueuedAt.toISOString()}`,
        );
        continue;
      }

      let admin = adminByShop.get(row.shop);
      if (!admin) {
        admin = (await unauthenticated.admin(row.shop))
          .admin as unknown as AdminClient;
        adminByShop.set(row.shop, admin);
      }

      const outcome = await fetchBillingAttemptOutcome(
        admin,
        row.shopifyBillingAttemptGid,
      );
      if (!outcome) {
        result.unresolvable += 1;
        console.warn(
          `[billing-reconciler] STALE ${row.status} row whose Shopify attempt can't be read — needs manual review. ` +
            `shop=${row.shop} key=${row.idempotencyKey} gid=${row.shopifyBillingAttemptGid}`,
        );
        continue;
      }

      if (outcome.kind === "pending") {
        // Shopify is still processing — genuinely slow, not lost. Leave it.
        result.stillPending += 1;
        continue;
      }

      if (outcome.kind === "success") {
        const { applied } = await markSucceeded(db, row.idempotencyKey, {
          shopifyBillingAttemptGid: row.shopifyBillingAttemptGid,
        });
        if (applied) {
          result.recoveredSucceeded += 1;
          console.log(
            `[billing-reconciler] recovered missed SUCCESS shop=${row.shop} key=${row.idempotencyKey}`,
          );
        }
        continue;
      }

      // failed / action_required — run the exact failure-recovery path the
      // webhooks use, dunning schedule included.
      const ctx: FailureContext = {
        shop: row.shop,
        subscriptionContractGid: row.subscriptionContractGid,
        billingCycleIndex: row.billingCycleIndex,
        attemptNumber: row.attemptNumber,
        idempotencyKey: row.idempotencyKey,
      };
      const plan = planFailureRecovery(
        ctx,
        {
          errorCode:
            outcome.kind === "failed" ? outcome.errorCode : null,
          errorMessage:
            outcome.kind === "failed"
              ? (outcome.errorMessage ?? "recovered by reconciliation sweep")
              : "3-D Secure action required (recovered by reconciliation sweep)",
          requiresAction: outcome.kind === "action_required",
          retryable: true,
        },
        now,
      );
      await applyFailureRecovery(db, ctx, plan);
      result.recoveredFailed += 1;
      console.log(
        `[billing-reconciler] recovered missed ${outcome.kind.toUpperCase()} shop=${row.shop} key=${row.idempotencyKey}`,
      );
    } catch (e: any) {
      result.errors.push({
        idempotencyKey: row.idempotencyKey,
        error: e?.message ?? String(e),
      });
    }
  }

  return result;
}
