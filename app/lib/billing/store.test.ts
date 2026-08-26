import { describe, expect, it } from "vitest";
import {
  deleteTerminalAttemptsOlderThan,
  enqueueAttempt,
  hasSucceededAttemptForCycle,
  listInFlightAttemptsOlderThan,
  markDeadLettered,
  markFailed,
  markSkipped,
  markSucceeded,
  type BillingAttemptRecord,
} from "./store.server";

/**
 * A minimal in-memory stand-in for the one Prisma model these functions
 * touch (billingCycleAttempt). Real Prisma can't run in this sandbox (see
 * claude/subscrify-status.md — binaries.prisma.sh is blocked), and the rest
 * of this app's *.server.ts glue is deliberately left to the running app to
 * exercise rather than unit tested (see charge.server.ts's top comment).
 *
 * This file breaks that convention on purpose for one reason: the guard
 * added here (hasSucceededAttemptForCycle + markSucceeded now accepting
 * REQUIRES_ACTION) is the fix for a confirmed invariant-#1 violation — a
 * 3-D Secure challenge that resolves successfully could previously be
 * double-charged by an already-scheduled dunning retry (see store.server.ts
 * and charge.server.ts's doc comments). That's severe enough to warrant a
 * real regression test over relying on live E2E testing alone, since a
 * 3-D-Secure-requiring card isn't something the dev store can reliably
 * simulate on demand.
 */
function fakeDb() {
  const rows: BillingAttemptRecord[] = [];
  let seq = 0;

  return {
    rows,
    billingCycleAttempt: {
      async create({ data }: { data: any }) {
        if (rows.some((r) => r.idempotencyKey === data.idempotencyKey)) {
          const err: any = new Error("unique constraint");
          err.code = "P2002";
          throw err;
        }
        const row: BillingAttemptRecord = {
          id: `row_${++seq}`,
          shop: data.shop,
          subscriptionContractGid: data.subscriptionContractGid,
          billingCycleIndex: data.billingCycleIndex,
          attemptNumber: data.attemptNumber,
          idempotencyKey: data.idempotencyKey,
          status: data.status,
          shopifyBillingAttemptGid: null,
          errorCode: null,
          errorMessage: null,
          nextRetryAt: data.nextRetryAt ?? null,
          enqueuedAt: data.enqueuedAt ?? new Date(),
          completedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        rows.push(row);
        return row;
      },
      async updateMany({ where, data }: { where: any; data: any }) {
        const statusIn: string[] | undefined = where.status?.in;
        let count = 0;
        for (const row of rows) {
          if (row.idempotencyKey !== where.idempotencyKey) continue;
          if (statusIn && !statusIn.includes(row.status)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      },
      async findFirst({ where }: { where: any }) {
        return (
          rows.find(
            (r) =>
              r.shop === where.shop &&
              r.subscriptionContractGid === where.subscriptionContractGid &&
              r.billingCycleIndex === where.billingCycleIndex &&
              r.status === where.status,
          ) ?? null
        );
      },
      async findUnique({ where }: { where: any }) {
        return rows.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null;
      },
      async findMany({ where, take }: { where: any; take?: number }) {
        const statusIn: string[] | undefined = where?.status?.in;
        const before: Date | undefined = where?.enqueuedAt?.lt;
        const matched = rows.filter(
          (r) =>
            (!statusIn || statusIn.includes(r.status)) &&
            (!before || r.enqueuedAt.getTime() < before.getTime()),
        );
        return take ? matched.slice(0, take) : matched;
      },
      async deleteMany({ where }: { where: any }) {
        const statusIn: string[] | undefined = where?.status?.in;
        const before: Date | undefined = where?.enqueuedAt?.lt;
        const keep: BillingAttemptRecord[] = [];
        let count = 0;
        for (const r of rows) {
          const matches =
            (!statusIn || statusIn.includes(r.status)) &&
            (!before || r.enqueuedAt.getTime() < before.getTime());
          if (matches) count += 1;
          else keep.push(r);
        }
        rows.length = 0;
        rows.push(...keep);
        return { count };
      },
    },
  } as any;
}

const shop = "subscrify-test.myshopify.com";
const contract = "gid://shopify/SubscriptionContract/19323781338";

describe("the 3-D Secure challenge double-charge fix", () => {
  it("markSucceeded applies to a REQUIRES_ACTION row — the resolved-challenge webhook is no longer dropped", async () => {
    const db = fakeDb();
    const key = "subscrify-v1-attempt1";
    await db.billingCycleAttempt.create({
      data: { shop, subscriptionContractGid: contract, billingCycleIndex: 2, attemptNumber: 1, idempotencyKey: key, status: "ENQUEUED" },
    });
    // Challenge issued: attempt moves to REQUIRES_ACTION (mirrors what
    // handleBillingAttemptWebhook does via applyFailureRecovery).
    await markFailed(db, key, { requiresAction: true, errorCode: null, errorMessage: "3DS challenge" });
    expect(db.rows[0].status).toBe("REQUIRES_ACTION");

    // Before the fix, this was a silent no-op because REQUIRES_ACTION wasn't
    // in markSucceeded's allowed source-status set.
    const result = await markSucceeded(db, key, { shopifyBillingAttemptGid: "gid://shopify/SubscriptionBillingAttempt/1" });
    expect(result.applied).toBe(true);
    expect(db.rows[0].status).toBe("SUCCEEDED");
  });

  it("hasSucceededAttemptForCycle finds a success recorded under a different attempt number", async () => {
    const db = fakeDb();
    await db.billingCycleAttempt.create({
      data: { shop, subscriptionContractGid: contract, billingCycleIndex: 2, attemptNumber: 1, idempotencyKey: "k1", status: "REQUIRES_ACTION" },
    });
    await markSucceeded(db, "k1", {});

    expect(await hasSucceededAttemptForCycle(db, shop, contract, 2)).toBe(true);
    // A different cycle on the same contract is unaffected.
    expect(await hasSucceededAttemptForCycle(db, shop, contract, 3)).toBe(false);
  });

  it("a scheduled retry never overwrites a row that already succeeded — markSkipped, not markSucceeded/markFailed, applies", async () => {
    const db = fakeDb();
    // Original attempt: challenged, then resolved successfully.
    await db.billingCycleAttempt.create({
      data: { shop, subscriptionContractGid: contract, billingCycleIndex: 2, attemptNumber: 1, idempotencyKey: "orig", status: "REQUIRES_ACTION" },
    });
    await markSucceeded(db, "orig", {});

    // The dunning retry that was already scheduled the moment the challenge
    // was issued (a separate row, its own idempotency key) is still sitting
    // ENQUEUED when it fires days later.
    const retryKey = "orig-retry2";
    await db.billingCycleAttempt.create({
      data: { shop, subscriptionContractGid: contract, billingCycleIndex: 2, attemptNumber: 2, idempotencyKey: retryKey, status: "ENQUEUED" },
    });

    // This is the exact guard processBillingAttemptMessage runs before
    // charging — confirm the cycle already succeeded, then retire the retry
    // via markSkipped instead of ever calling chargeBillingCycle.
    expect(await hasSucceededAttemptForCycle(db, shop, contract, 2)).toBe(true);
    await markSkipped(db, retryKey, { errorCode: "CYCLE_ALREADY_SUCCEEDED", errorMessage: "already paid" });

    const retryRow = db.rows.find((r: BillingAttemptRecord) => r.idempotencyKey === retryKey)!;
    expect(retryRow.status).toBe("SKIPPED");
    // The original SUCCEEDED row is untouched.
    expect(db.rows.find((r: BillingAttemptRecord) => r.idempotencyKey === "orig")!.status).toBe("SUCCEEDED");
  });

  it("markSucceeded still no-ops on an already-terminal row (FAILED/SKIPPED/DEAD_LETTERED) — a stray success signal can't resurrect it", async () => {
    const db = fakeDb();
    await db.billingCycleAttempt.create({
      data: { shop, subscriptionContractGid: contract, billingCycleIndex: 2, attemptNumber: 1, idempotencyKey: "k", status: "SKIPPED" },
    });
    const result = await markSucceeded(db, "k", {});
    expect(result.applied).toBe(false);
    expect(db.rows[0].status).toBe("SKIPPED");
  });

  it("enqueueAttempt's uniqueness still prevents a duplicate retry row even if applyFailureRecovery runs twice for the same failed attempt", async () => {
    const db = fakeDb();
    const key = "dup-retry-key";
    const first = await enqueueAttempt(db, { shop, subscriptionContractGid: contract, billingCycleIndex: 2, attemptNumber: 2, idempotencyKey: key });
    const second = await enqueueAttempt(db, { shop, subscriptionContractGid: contract, billingCycleIndex: 2, attemptNumber: 2, idempotencyKey: key });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(db.rows.filter((r: BillingAttemptRecord) => r.idempotencyKey === key)).toHaveLength(1);
  });

  it("enqueueAttempt records a dunning retry's scheduled fire time on the row", async () => {
    const db = fakeDb();
    const fireAt = new Date("2026-09-01T00:00:00.000Z");
    await enqueueAttempt(db, {
      shop, subscriptionContractGid: contract, billingCycleIndex: 2,
      attemptNumber: 2, idempotencyKey: "retry-with-schedule", nextRetryAt: fireAt,
    });
    expect(db.rows[0].nextRetryAt?.toISOString()).toBe(fireAt.toISOString());
  });
});

describe("dead-letter bookkeeping", () => {
  it("markDeadLettered transitions an in-flight row and records the reason", async () => {
    const db = fakeDb();
    await db.billingCycleAttempt.create({
      data: { shop, subscriptionContractGid: contract, billingCycleIndex: 2, attemptNumber: 1, idempotencyKey: "dlq", status: "CHARGING" },
    });
    const result = await markDeadLettered(db, "dlq", { errorMessage: "MaxDeliveryCountExceeded" });
    expect(result.applied).toBe(true);
    expect(db.rows[0].status).toBe("DEAD_LETTERED");
    expect(db.rows[0].errorMessage).toBe("MaxDeliveryCountExceeded");
  });

  it("markDeadLettered never downgrades a row a webhook already resolved", async () => {
    const db = fakeDb();
    await db.billingCycleAttempt.create({
      data: { shop, subscriptionContractGid: contract, billingCycleIndex: 2, attemptNumber: 1, idempotencyKey: "resolved", status: "SUCCEEDED" },
    });
    const result = await markDeadLettered(db, "resolved", { errorMessage: "late DLQ" });
    expect(result.applied).toBe(false);
    expect(db.rows[0].status).toBe("SUCCEEDED");
  });
});

describe("retention purge and stale listing", () => {
  const old = new Date("2024-01-01T00:00:00.000Z");
  const recent = new Date("2026-08-01T00:00:00.000Z");
  const cutoff = new Date("2024-08-26T00:00:00.000Z");

  it("deleteTerminalAttemptsOlderThan deletes only terminal rows past the cutoff", async () => {
    const db = fakeDb();
    const mk = (key: string, status: string, enqueuedAt: Date) =>
      db.billingCycleAttempt.create({
        data: { shop, subscriptionContractGid: contract, billingCycleIndex: 1, attemptNumber: 1, idempotencyKey: key, status, enqueuedAt },
      });
    await mk("old-succeeded", "SUCCEEDED", old);
    await mk("old-failed", "FAILED", old);
    await mk("old-in-flight", "CHARGING", old); // stuck row: NEVER purged
    await mk("old-requires-action", "REQUIRES_ACTION", old); // in-flight-ish: kept
    await mk("recent-succeeded", "SUCCEEDED", recent);

    const { deleted } = await deleteTerminalAttemptsOlderThan(db, cutoff);
    expect(deleted).toBe(2);
    const remaining = db.rows.map((r: BillingAttemptRecord) => r.idempotencyKey).sort();
    expect(remaining).toEqual(["old-in-flight", "old-requires-action", "recent-succeeded"]);
  });

  it("listInFlightAttemptsOlderThan returns only in-flight rows older than the bound", async () => {
    const db = fakeDb();
    const mk = (key: string, status: string, enqueuedAt: Date) =>
      db.billingCycleAttempt.create({
        data: { shop, subscriptionContractGid: contract, billingCycleIndex: 1, attemptNumber: 1, idempotencyKey: key, status, enqueuedAt },
      });
    await mk("old-charging", "CHARGING", old);
    await mk("old-enqueued", "ENQUEUED", old);
    await mk("old-succeeded", "SUCCEEDED", old);
    await mk("fresh-charging", "CHARGING", recent);

    const rows = await listInFlightAttemptsOlderThan(db, cutoff);
    expect(rows.map((r: BillingAttemptRecord) => r.idempotencyKey).sort()).toEqual([
      "old-charging",
      "old-enqueued",
    ]);
  });
});
