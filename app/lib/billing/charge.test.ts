import { describe, expect, it } from "vitest";
import { planFailureRecovery, type FailureContext } from "./charge.server";
import { MAX_BILLING_ATTEMPTS } from "./dunning.server";

const ctx: FailureContext = {
  shop: "subscrify-test.myshopify.com",
  subscriptionContractGid: "gid://shopify/SubscriptionContract/19323781338",
  billingCycleIndex: 2,
  attemptNumber: 1,
  idempotencyKey: "subscrify-v1-subscrify-test.myshopify.com-19323781338-2",
};

const now = new Date("2026-08-31T00:00:00.000Z");

describe("planFailureRecovery", () => {
  it("schedules a retry for a retryable failure below the attempt ceiling", () => {
    const plan = planFailureRecovery(
      ctx,
      { errorCode: "PROCESSING_FAILED", errorMessage: "card declined", requiresAction: false, retryable: true },
      now,
    );
    expect(plan.markFailed.errorCode).toBe("PROCESSING_FAILED");
    expect(plan.markFailed.requiresAction).toBe(false);
    expect(plan.markFailed.nextRetryAt).not.toBeNull();
    expect(plan.retry).not.toBeNull();
    expect(plan.retry?.attemptNumber).toBe(2);
    expect(plan.retry?.idempotencyKey).toBe(`${ctx.idempotencyKey}-retry2`);
    expect(plan.retry?.scheduledEnqueueTimeUtc).toEqual(plan.markFailed.nextRetryAt);
  });

  it("gives up (no retry) when the outcome is marked non-retryable", () => {
    const plan = planFailureRecovery(
      ctx,
      { errorCode: "CONTRACT_PAUSED", errorMessage: "contract is paused", requiresAction: false, retryable: false },
      now,
    );
    expect(plan.retry).toBeNull();
    expect(plan.markFailed.nextRetryAt).toBeNull();
    expect(plan.markFailed.errorCode).toBe("CONTRACT_PAUSED");
  });

  it("gives up once the failing attempt is already at MAX_BILLING_ATTEMPTS, even if retryable", () => {
    const plan = planFailureRecovery(
      { ...ctx, attemptNumber: MAX_BILLING_ATTEMPTS },
      { errorCode: "PROCESSING_FAILED", errorMessage: null, requiresAction: false, retryable: true },
      now,
    );
    expect(plan.retry).toBeNull();
  });

  it("marks REQUIRES_ACTION distinctly from FAILED but still applies the same dunning schedule", () => {
    const plan = planFailureRecovery(
      ctx,
      { errorCode: null, errorMessage: "3-D Secure challenge issued", requiresAction: true, retryable: true },
      now,
    );
    expect(plan.markFailed.requiresAction).toBe(true);
    expect(plan.retry?.attemptNumber).toBe(2);
  });

  it("derives the retry idempotency key from the SAME (shop, contract, cycle) — never the current attempt's key", () => {
    const plan = planFailureRecovery(
      { ...ctx, attemptNumber: 2, idempotencyKey: `${ctx.idempotencyKey}-retry2` },
      { errorCode: "PROCESSING_FAILED", errorMessage: null, requiresAction: false, retryable: true },
      now,
    );
    expect(plan.retry?.idempotencyKey).toBe(`${ctx.idempotencyKey}-retry3`);
    expect(plan.retry?.idempotencyKey).not.toBe(ctx.idempotencyKey);
  });

  it("is a pure function — same inputs, same plan", () => {
    const a = planFailureRecovery(
      ctx,
      { errorCode: "PROCESSING_FAILED", errorMessage: "x", requiresAction: false, retryable: true },
      now,
    );
    const b = planFailureRecovery(
      { ...ctx },
      { errorCode: "PROCESSING_FAILED", errorMessage: "x", requiresAction: false, retryable: true },
      new Date(now),
    );
    expect(a).toEqual(b);
  });
});
