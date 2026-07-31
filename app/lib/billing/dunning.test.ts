import { describe, expect, it } from "vitest";
import {
  MAX_BILLING_ATTEMPTS,
  decideDunning,
  isRetryableMutationError,
} from "./dunning.server";

const now = new Date("2026-08-31T00:00:00.000Z");

describe("decideDunning", () => {
  it("schedules a retry after attempt 1 fails, 3 days out", () => {
    const decision = decideDunning(1, now);
    expect(decision.action).toBe("RETRY");
    if (decision.action !== "RETRY") throw new Error("unreachable");
    expect(decision.nextAttemptNumber).toBe(2);
    expect(decision.nextRetryAt.toISOString()).toBe("2026-09-03T00:00:00.000Z");
  });

  it("schedules a retry after attempt 2 fails, 5 days out", () => {
    const decision = decideDunning(2, now);
    expect(decision.action).toBe("RETRY");
    if (decision.action !== "RETRY") throw new Error("unreachable");
    expect(decision.nextAttemptNumber).toBe(3);
    expect(decision.nextRetryAt.toISOString()).toBe("2026-09-05T00:00:00.000Z");
  });

  it("schedules a retry after attempt 3 fails, 7 days out", () => {
    const decision = decideDunning(3, now);
    expect(decision.action).toBe("RETRY");
    if (decision.action !== "RETRY") throw new Error("unreachable");
    expect(decision.nextAttemptNumber).toBe(4);
    expect(decision.nextRetryAt.toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });

  it("gives up once the final attempt (MAX_BILLING_ATTEMPTS) fails", () => {
    expect(decideDunning(MAX_BILLING_ATTEMPTS, now)).toEqual({ action: "GIVE_UP" });
  });

  it("never retries past MAX_BILLING_ATTEMPTS even if called with a larger number", () => {
    expect(decideDunning(MAX_BILLING_ATTEMPTS + 5, now)).toEqual({ action: "GIVE_UP" });
  });

  it("rejects invalid attempt numbers", () => {
    expect(() => decideDunning(0, now)).toThrow(/invalid attempt number/);
    expect(() => decideDunning(-1, now)).toThrow(/invalid attempt number/);
    expect(() => decideDunning(1.5, now)).toThrow(/invalid attempt number/);
  });

  it("is a pure function of its inputs — same args, same result", () => {
    expect(decideDunning(1, now)).toEqual(decideDunning(1, new Date(now)));
  });
});

describe("isRetryableMutationError", () => {
  it("treats THROTTLED and PROCESSING_FAILED as retryable", () => {
    expect(isRetryableMutationError("THROTTLED")).toBe(true);
    expect(isRetryableMutationError("PROCESSING_FAILED")).toBe(true);
  });

  it("treats contract/cycle state errors as terminal, not retryable", () => {
    expect(isRetryableMutationError("CONTRACT_TERMINATED")).toBe(false);
    expect(isRetryableMutationError("CONTRACT_PAUSED")).toBe(false);
    expect(isRetryableMutationError("BILLING_CYCLE_SKIPPED")).toBe(false);
    expect(isRetryableMutationError("CYCLE_INDEX_OUT_OF_RANGE")).toBe(false);
    expect(isRetryableMutationError("CONTRACT_NOT_FOUND")).toBe(false);
  });

  it("treats malformed-input errors as terminal (retrying can't fix our own bug)", () => {
    expect(isRetryableMutationError("INVALID")).toBe(false);
    expect(isRetryableMutationError("BLANK")).toBe(false);
  });

  it("defaults unknown codes to non-retryable (fail closed, never loop forever on a surprise code)", () => {
    expect(isRetryableMutationError("SOME_FUTURE_CODE_WE_DONT_KNOW")).toBe(false);
  });
});
