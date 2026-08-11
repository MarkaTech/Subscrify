import { describe, expect, it } from "vitest";
import { isBillableStatus, isContractDue, pickDueCycle } from "./scheduler.server";

const now = new Date("2026-08-31T12:00:00.000Z");

describe("isContractDue", () => {
  it("is due when ACTIVE and nextBillingDate has arrived", () => {
    expect(
      isContractDue({ status: "ACTIVE", nextBillingDate: "2026-08-31T00:00:00.000Z" }, now),
    ).toBe(true);
  });

  it("is due when nextBillingDate is exactly now", () => {
    expect(
      isContractDue({ status: "ACTIVE", nextBillingDate: now.toISOString() }, now),
    ).toBe(true);
  });

  it("is not due when nextBillingDate is in the future", () => {
    expect(
      isContractDue({ status: "ACTIVE", nextBillingDate: "2026-09-30T00:00:00.000Z" }, now),
    ).toBe(false);
  });

  it("is never due when not ACTIVE, even if the date has passed", () => {
    for (const status of ["PAUSED", "CANCELLED", "EXPIRED", "FAILED"]) {
      expect(
        isContractDue({ status, nextBillingDate: "2020-01-01T00:00:00.000Z" }, now),
      ).toBe(false);
    }
  });

  it("is not due when nextBillingDate is null", () => {
    expect(isContractDue({ status: "ACTIVE", nextBillingDate: null }, now)).toBe(false);
  });
});

describe("pickDueCycle", () => {
  it("returns null when there are no cycles", () => {
    expect(pickDueCycle([], now)).toBeNull();
  });

  it("returns null when every cycle is already billed", () => {
    const cycles = [
      { cycleIndex: 1, billingAttemptExpectedDate: "2026-07-31T00:00:00.000Z", status: "BILLED" as const, skipped: false },
      { cycleIndex: 2, billingAttemptExpectedDate: "2026-08-31T00:00:00.000Z", status: "BILLED" as const, skipped: false },
    ];
    expect(pickDueCycle(cycles, now)).toBeNull();
  });

  it("returns null when the only unbilled cycle isn't due yet", () => {
    const cycles = [
      { cycleIndex: 3, billingAttemptExpectedDate: "2026-09-30T00:00:00.000Z", status: "UNBILLED" as const, skipped: false },
    ];
    expect(pickDueCycle(cycles, now)).toBeNull();
  });

  it("ignores skipped cycles even if unbilled and due", () => {
    const cycles = [
      { cycleIndex: 2, billingAttemptExpectedDate: "2026-08-31T00:00:00.000Z", status: "UNBILLED" as const, skipped: true },
    ];
    expect(pickDueCycle(cycles, now)).toBeNull();
  });

  it("picks the single due, unbilled, unskipped cycle", () => {
    const cycles = [
      { cycleIndex: 1, billingAttemptExpectedDate: "2026-07-31T00:00:00.000Z", status: "BILLED" as const, skipped: false },
      { cycleIndex: 2, billingAttemptExpectedDate: "2026-08-31T00:00:00.000Z", status: "UNBILLED" as const, skipped: false },
    ];
    expect(pickDueCycle(cycles, now)?.cycleIndex).toBe(2);
  });

  it("picks the EARLIEST due cycle when a backlog has piled up (never skips straight to newest)", () => {
    const cycles = [
      { cycleIndex: 3, billingAttemptExpectedDate: "2026-08-31T00:00:00.000Z", status: "UNBILLED" as const, skipped: false },
      { cycleIndex: 2, billingAttemptExpectedDate: "2026-07-31T00:00:00.000Z", status: "UNBILLED" as const, skipped: false },
      { cycleIndex: 1, billingAttemptExpectedDate: "2026-06-30T00:00:00.000Z", status: "UNBILLED" as const, skipped: false },
    ];
    expect(pickDueCycle(cycles, now)?.cycleIndex).toBe(1);
  });

  it("does not pick an unbilled cycle that isn't due yet, even if others are", () => {
    const cycles = [
      { cycleIndex: 1, billingAttemptExpectedDate: "2026-07-31T00:00:00.000Z", status: "UNBILLED" as const, skipped: false },
      { cycleIndex: 2, billingAttemptExpectedDate: "2026-09-30T00:00:00.000Z", status: "UNBILLED" as const, skipped: false },
    ];
    expect(pickDueCycle(cycles, now)?.cycleIndex).toBe(1);
  });
});

describe("isBillableStatus (Phase 5 — pause/cancel guard)", () => {
  it("only ACTIVE is billable", () => {
    expect(isBillableStatus("ACTIVE")).toBe(true);
  });

  it("refuses to bill a paused contract", () => {
    // The whole point of pause: a merchant or customer asked billing to stop.
    expect(isBillableStatus("PAUSED")).toBe(false);
  });

  it("refuses to bill a cancelled contract", () => {
    expect(isBillableStatus("CANCELLED")).toBe(false);
  });

  it("fails closed on unknown, missing, or future statuses", () => {
    // Never charge money on a status we don't recognise.
    expect(isBillableStatus("EXPIRED")).toBe(false);
    expect(isBillableStatus("SOMETHING_SHOPIFY_ADDS_LATER")).toBe(false);
    expect(isBillableStatus(null)).toBe(false);
    expect(isBillableStatus(undefined)).toBe(false);
    expect(isBillableStatus("")).toBe(false);
  });

  it("keeps isContractDue consistent with it", () => {
    const past = new Date("2026-01-01T00:00:00Z").toISOString();
    const now = new Date("2026-06-01T00:00:00Z");
    expect(isContractDue({ status: "ACTIVE", nextBillingDate: past }, now)).toBe(true);
    expect(isContractDue({ status: "PAUSED", nextBillingDate: past }, now)).toBe(false);
    expect(isContractDue({ status: "CANCELLED", nextBillingDate: past }, now)).toBe(false);
  });
});
