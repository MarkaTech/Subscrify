/**
 * Boots the billing scheduler tick inside the web process (Phase 4).
 *
 * The worker container scales to zero when the billing-attempts queue is
 * empty (see infra/main.bicep), so nothing there can reliably notice a newly
 * due contract. The web app's minReplicas is pinned to 1 (embedded-admin
 * iframes need a warm replica anyway), so it's the natural always-on home
 * for "is anything due yet?" — see run-scheduler.server.ts for the tick
 * itself and its module comment for why running this on every web replica
 * concurrently is safe rather than a bug to guard against.
 *
 * Gated behind ENABLE_BILLING_SCHEDULER so local dev / CI don't spin up an
 * interval that immediately fails on a missing SERVICEBUS_CONNECTION.
 */

import prisma from "../../db.server";
import { runSchedulerTick } from "./run-scheduler.server";
import { reconcileStaleAttempts } from "./reconcile.server";
import { purgeExpiredBillingAttempts } from "./retention.server";

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 15_000;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var __subscrifySchedulerStarted: boolean | undefined;
}

export function startBillingSchedulerLoop(): void {
  if (global.__subscrifySchedulerStarted) return;
  global.__subscrifySchedulerStarted = true;

  if (process.env.ENABLE_BILLING_SCHEDULER !== "true") {
    console.log(
      "[billing-scheduler] disabled (set ENABLE_BILLING_SCHEDULER=true to enable)",
    );
    return;
  }

  console.log(
    `[billing-scheduler] starting — tick every ${TICK_INTERVAL_MS / 1000}s`,
  );

  let lastPurgeAt = 0;

  const tick = async () => {
    try {
      const result = await runSchedulerTick(prisma, new Date());
      if (result.enqueued > 0 || result.errors.length > 0) {
        console.log("[billing-scheduler] tick", JSON.stringify(result));
      }
    } catch (e) {
      console.error("[billing-scheduler] tick failed", e);
    }

    // Reconciliation sweep piggybacks on the same interval: it's the safety
    // net for missed webhooks / stuck in-flight rows (see reconcile.server.ts).
    // Failures here must never take the scheduler down with them.
    try {
      const rec = await reconcileStaleAttempts(prisma, new Date());
      if (rec.checked > 0) {
        console.log("[billing-reconciler] sweep", JSON.stringify(rec));
      }
    } catch (e) {
      console.error("[billing-reconciler] sweep failed", e);
    }

    // Retention purge runs at most daily (per process — a restart just runs
    // it again, which is an idempotent no-op when there's nothing to purge).
    if (Date.now() - lastPurgeAt >= PURGE_INTERVAL_MS) {
      lastPurgeAt = Date.now();
      try {
        await purgeExpiredBillingAttempts(prisma, new Date());
      } catch (e) {
        console.error("[billing-retention] purge failed", e);
      }
    }
  };

  setTimeout(tick, INITIAL_DELAY_MS);
  setInterval(tick, TICK_INTERVAL_MS);
}
