/**
 * Dunning policy — Phase 4 billing engine.
 *
 * Governs what happens after a billing attempt does not succeed: how many
 * times to retry, how long to wait between retries, and when to stop.
 *
 * Retrying is itself invariant-#1-safe (never overbill): every retry gets
 * its own idempotency key (billingRetryIdempotencyKey), so a retry can never
 * collide with — or duplicate — a cycle that already succeeded, and a retry
 * that itself fails cannot be replayed into a duplicate charge either.
 *
 * Pure functions only — no network, no framework, no Date.now() side effects
 * beyond taking "now" as an explicit argument — so the whole policy is
 * unit-testable without a clock or a queue.
 */

/** 1 initial attempt + 3 dunning retries, then give up and flag for review. */
export const MAX_BILLING_ATTEMPTS = 4;

/** Days to wait after attempt N fails before trying attempt N+1 (1-indexed by N). */
const RETRY_BACKOFF_DAYS = [3, 5, 7];

export type DunningDecision =
  | { action: "RETRY"; nextAttemptNumber: number; nextRetryAt: Date }
  | { action: "GIVE_UP" };

/**
 * Decide what happens after `failedAttemptNumber` has just failed (or been
 * 3D-Secure-challenged and not resolved — see charge.server.ts). `now` is
 * injected so this stays a pure function.
 */
export function decideDunning(
  failedAttemptNumber: number,
  now: Date,
): DunningDecision {
  if (!Number.isInteger(failedAttemptNumber) || failedAttemptNumber < 1) {
    throw new Error(
      `decideDunning: invalid attempt number "${failedAttemptNumber}"`,
    );
  }

  if (failedAttemptNumber >= MAX_BILLING_ATTEMPTS) {
    return { action: "GIVE_UP" };
  }

  const waitDays =
    RETRY_BACKOFF_DAYS[failedAttemptNumber - 1] ??
    RETRY_BACKOFF_DAYS[RETRY_BACKOFF_DAYS.length - 1];

  return {
    action: "RETRY",
    nextAttemptNumber: failedAttemptNumber + 1,
    nextRetryAt: new Date(now.getTime() + waitDays * 24 * 60 * 60 * 1000),
  };
}

/**
 * Synchronous userErrors from subscriptionBillingAttemptCreate itself (i.e.
 * the mutation call was rejected before Shopify even attempted payment).
 * Only a narrow set of these are transient/worth retrying on our fixed
 * schedule — the rest indicate the contract/cycle state has changed (paused,
 * terminated, already skipped, out of range) or that our own request was
 * malformed, and blindly retrying either can't help or would mask a bug.
 */
const RETRYABLE_MUTATION_ERROR_CODES = new Set(["THROTTLED", "PROCESSING_FAILED"]);

export function isRetryableMutationError(code: string): boolean {
  return RETRYABLE_MUTATION_ERROR_CODES.has(code);
}
