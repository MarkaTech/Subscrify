/**
 * Retention purge for billing-attempt records.
 *
 * The published privacy policy (app/legal/privacy.md §7) states billing
 * attempt records are kept 24 months on an active store and then deleted
 * automatically. This module is what makes that sentence true — the policy
 * and this code must move together (the house rule: never publish a claim
 * the code doesn't implement).
 *
 * Only TERMINAL rows are purged; see deleteTerminalAttemptsOlderThan in
 * store.server.ts for why deleting old rows cannot break invariant #1.
 *
 * RETENTION FLOOR: the scheduler looks back 400 days for missed billing
 * cycles (queries.server.ts). Retention is clamped to never drop below 14
 * months so a misconfigured BILLING_RETENTION_MONTHS can't delete rows for
 * cycles the scheduler could still encounter in its lookback window.
 */

import type { PrismaClient } from "@prisma/client";
import { deleteTerminalAttemptsOlderThan } from "./store.server";

export const DEFAULT_RETENTION_MONTHS = 24;
export const MIN_RETENTION_MONTHS = 14;

export function configuredRetentionMonths(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.BILLING_RETENTION_MONTHS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const months = Number.isFinite(parsed) ? parsed : DEFAULT_RETENTION_MONTHS;
  return Math.max(months, MIN_RETENTION_MONTHS);
}

/** `months` calendar months before `now`, clamped by JS Date month arithmetic. */
export function retentionCutoff(now: Date, months: number): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff;
}

export async function purgeExpiredBillingAttempts(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<{ deleted: number; cutoff: Date }> {
  const cutoff = retentionCutoff(now, configuredRetentionMonths());
  const { deleted } = await deleteTerminalAttemptsOlderThan(db, cutoff);
  if (deleted > 0) {
    console.log(
      `[billing-retention] purged ${deleted} billing attempt record(s) older than ${cutoff.toISOString()}`,
    );
  }
  return { deleted, cutoff };
}
