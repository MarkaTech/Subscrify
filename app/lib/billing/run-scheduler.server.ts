/**
 * Scheduler tick — Phase 4 billing engine.
 *
 * Finds every ACTIVE, due contract across every installed shop and enqueues
 * (at most) one billing attempt per contract per tick. Runs on an interval
 * inside the always-on web process (see schedule-loop.server.ts) rather than
 * the worker, because the worker scales to zero on an empty queue and so
 * cannot be relied on to notice a newly-due contract on its own.
 *
 * Safe to run concurrently across multiple web replicas or overlapping
 * ticks: every enqueue goes through the same idempotency-keyed insert as
 * everything else in this engine (store.enqueueAttempt) — a duplicate tick
 * just does redundant, no-op work, never a duplicate charge. That's
 * deliberate defense-in-depth, not a gap to "fix" with a distributed lock;
 * see idempotency.server.ts for the full invariant-#1 chain.
 */

import type { PrismaClient } from "@prisma/client";
import { unauthenticated } from "../../shopify.server";
import type { AdminClient } from "../selling-plans/api.server";
import { billingAttemptIdempotencyKey } from "./idempotency.server";
import {
  fetchContractStatus,
  fetchDueContracts,
  fetchDueCycle,
  fetchEarliestUnbilledCycle,
} from "./queries.server";
import { isBillableStatus } from "./scheduler.server";
import { enqueueAttempt, listInstalledShops } from "./store.server";
import { sendBillingAttemptMessage } from "./queue.server";

export interface SchedulerTickResult {
  shopsChecked: number;
  contractsDue: number;
  enqueued: number;
  alreadyEnqueued: number;
  errors: Array<{ shop: string; error: string }>;
}

export async function runSchedulerTick(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<SchedulerTickResult> {
  const result: SchedulerTickResult = {
    shopsChecked: 0,
    contractsDue: 0,
    enqueued: 0,
    alreadyEnqueued: 0,
    errors: [],
  };

  const shops = await listInstalledShops(db);

  for (const shop of shops) {
    result.shopsChecked += 1;
    try {
      const { admin } = await unauthenticated.admin(shop);
      await tickForShop(db, shop, admin as unknown as AdminClient, now, result);
    } catch (e: any) {
      result.errors.push({ shop, error: e?.message ?? String(e) });
    }
  }

  return result;
}

async function tickForShop(
  db: PrismaClient,
  shop: string,
  admin: AdminClient,
  now: Date,
  result: SchedulerTickResult,
): Promise<void> {
  const dueContracts = await fetchDueContracts(admin, now);
  result.contractsDue += dueContracts.length;

  for (const contract of dueContracts) {
    const cycle = await fetchDueCycle(admin, contract.gid, now);
    if (!cycle) continue; // nothing unbilled and due for this contract right now

    const idempotencyKey = billingAttemptIdempotencyKey({
      shop,
      subscriptionContractGid: contract.gid,
      billingCycleIndex: cycle.cycleIndex,
    });

    const { created } = await enqueueAttempt(db, {
      shop,
      subscriptionContractGid: contract.gid,
      billingCycleIndex: cycle.cycleIndex,
      attemptNumber: 1,
      idempotencyKey,
    });

    if (!created) {
      result.alreadyEnqueued += 1;
      continue;
    }

    await sendBillingAttemptMessage({
      shop,
      subscriptionContractGid: contract.gid,
      billingCycleIndex: cycle.cycleIndex,
      attemptNumber: 1,
      idempotencyKey,
    });
    result.enqueued += 1;
  }
}

export type ForceBillOutcome =
  | "enqueued"
  | "already_in_flight"
  | "nothing_to_bill"
  | "not_billable";

export interface ForceBillResult {
  outcome: ForceBillOutcome;
  cycleIndex?: number;
  idempotencyKey?: string;
  /** Set on "not_billable": the contract status that blocked the charge. */
  status?: string;
}

/**
 * Manual "bill this cycle now" — a merchant-support action (see the
 * contract detail page action), not part of the scheduled path. Charges the
 * earliest UNBILLED cycle regardless of whether it's naturally due yet;
 * still goes through the exact same enqueue → Service Bus → worker path as
 * the scheduler, so it's real end-to-end billing, not a special case. If
 * the cycle isn't due yet, Shopify itself rejects the attempt (see
 * fetchEarliestUnbilledCycle's doc comment) rather than this function
 * silently overriding anything.
 *
 * STATUS GUARD (added with Phase 5 pause/cancel): this path deliberately
 * bypasses "is it due yet", so it must NOT also bypass "should this contract
 * be charged at all". The scheduled path never sees a paused or cancelled
 * contract — DUE_CONTRACTS_QUERY filters on status:ACTIVE and
 * isContractDue re-checks it — but this function reaches a contract by id,
 * so without an explicit check a merchant could pause a subscription at a
 * customer's request and then charge it anyway with one click. Shopify may
 * well accept that attempt for a PAUSED contract; "the API would probably
 * stop us" is not the standard the rest of this engine is held to.
 */
export async function forceBillContractNow(
  db: PrismaClient,
  admin: AdminClient,
  shop: string,
  subscriptionContractGid: string,
  now: Date = new Date(),
): Promise<ForceBillResult> {
  const status = await fetchContractStatus(admin, subscriptionContractGid);
  if (!isBillableStatus(status)) {
    return { outcome: "not_billable", status: status ?? "UNKNOWN" };
  }

  const cycle = await fetchEarliestUnbilledCycle(admin, subscriptionContractGid, now);
  if (!cycle) return { outcome: "nothing_to_bill" };

  const idempotencyKey = billingAttemptIdempotencyKey({
    shop,
    subscriptionContractGid,
    billingCycleIndex: cycle.cycleIndex,
  });

  const { created } = await enqueueAttempt(db, {
    shop,
    subscriptionContractGid,
    billingCycleIndex: cycle.cycleIndex,
    attemptNumber: 1,
    idempotencyKey,
  });

  if (!created) {
    return { outcome: "already_in_flight", cycleIndex: cycle.cycleIndex, idempotencyKey };
  }

  await sendBillingAttemptMessage({
    shop,
    subscriptionContractGid,
    billingCycleIndex: cycle.cycleIndex,
    attemptNumber: 1,
    idempotencyKey,
  });

  return { outcome: "enqueued", cycleIndex: cycle.cycleIndex, idempotencyKey };
}
