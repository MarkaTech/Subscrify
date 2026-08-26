import { describe, expect, it } from "vitest";
import { STALE_IN_FLIGHT_AFTER_MS, isStaleInFlight } from "./reconcile";
import {
  DEFAULT_RETENTION_MONTHS,
  MIN_RETENTION_MONTHS,
  configuredRetentionMonths,
  retentionCutoff,
} from "./retention.server";

const now = new Date("2026-08-26T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);
const daysFromNow = (d: number) => new Date(now.getTime() + d * 24 * 60 * 60 * 1000);

describe("isStaleInFlight", () => {
  it("flags a CHARGING row that has sat past the threshold", () => {
    expect(
      isStaleInFlight({ status: "CHARGING", enqueuedAt: hoursAgo(2), nextRetryAt: null }, now),
    ).toBe(true);
  });

  it("leaves a fresh in-flight row alone", () => {
    expect(
      isStaleInFlight(
        { status: "CHARGING", enqueuedAt: new Date(now.getTime() - STALE_IN_FLIGHT_AFTER_MS / 2), nextRetryAt: null },
        now,
      ),
    ).toBe(false);
  });

  it("does NOT flag a dunning retry that is still waiting for its scheduled fire time", () => {
    // Created 2 days ago, scheduled to fire 3 days from now: idle by design.
    expect(
      isStaleInFlight(
        { status: "ENQUEUED", enqueuedAt: hoursAgo(48), nextRetryAt: daysFromNow(3) },
        now,
      ),
    ).toBe(false);
  });

  it("flags that same retry once its fire time has passed with no progress", () => {
    expect(
      isStaleInFlight(
        { status: "ENQUEUED", enqueuedAt: hoursAgo(48), nextRetryAt: hoursAgo(2) },
        now,
      ),
    ).toBe(true);
  });

  it("never flags terminal rows regardless of age", () => {
    for (const status of ["SUCCEEDED", "FAILED", "SKIPPED", "DEAD_LETTERED", "REQUIRES_ACTION"]) {
      expect(
        isStaleInFlight({ status, enqueuedAt: hoursAgo(1000), nextRetryAt: null }, now),
      ).toBe(false);
    }
  });
});

describe("retention configuration", () => {
  it("defaults to 24 months when unset or garbage", () => {
    expect(configuredRetentionMonths({})).toBe(DEFAULT_RETENTION_MONTHS);
    expect(configuredRetentionMonths({ BILLING_RETENTION_MONTHS: "banana" })).toBe(
      DEFAULT_RETENTION_MONTHS,
    );
  });

  it("respects an explicit longer retention", () => {
    expect(configuredRetentionMonths({ BILLING_RETENTION_MONTHS: "36" })).toBe(36);
  });

  it("clamps to the floor so a misconfig can't undercut the scheduler's 400-day lookback", () => {
    expect(configuredRetentionMonths({ BILLING_RETENTION_MONTHS: "3" })).toBe(
      MIN_RETENTION_MONTHS,
    );
    // The floor itself must exceed the 400-day lookback.
    const floorCutoff = retentionCutoff(now, MIN_RETENTION_MONTHS);
    const lookbackStart = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
    expect(floorCutoff.getTime()).toBeLessThan(lookbackStart.getTime());
  });

  it("computes a calendar-month cutoff", () => {
    const cutoff = retentionCutoff(new Date("2026-08-26T12:00:00.000Z"), 24);
    expect(cutoff.toISOString()).toBe("2024-08-26T12:00:00.000Z");
  });
});
