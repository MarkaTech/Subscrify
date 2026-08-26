/**
 * Pure half of the reconciliation sweep — see reconcile.server.ts for the
 * sweep itself. Split exactly like contracts/lifecycle.ts vs
 * lifecycle.server.ts: this module must stay import-safe from tests (and
 * anywhere else) without dragging in shopify.server / Prisma, which cannot
 * initialize outside the running app.
 */

/** How long an in-flight row may sit past its expected active time before the sweep investigates. */
export const STALE_IN_FLIGHT_AFTER_MS = 45 * 60 * 1000;

export interface StaleCheckRow {
  status: string;
  enqueuedAt: Date;
  nextRetryAt: Date | null;
}

/**
 * Pure staleness decision. A row's "expected active time" is the later of
 * when it was created and (for dunning retries) when its queue message is
 * scheduled to fire — a retry created today for next Tuesday is healthy all
 * week, then becomes stale 45 minutes after Tuesday's fire time passes with
 * no progress.
 */
export function isStaleInFlight(row: StaleCheckRow, now: Date): boolean {
  if (row.status !== "ENQUEUED" && row.status !== "CHARGING") return false;
  const expectedActiveAt = Math.max(
    row.enqueuedAt.getTime(),
    row.nextRetryAt?.getTime() ?? 0,
  );
  return now.getTime() - expectedActiveAt > STALE_IN_FLIGHT_AFTER_MS;
}
