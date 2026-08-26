/**
 * Billing worker process entrypoint (Phase 4 billing engine).
 *
 * A long-running consumer of the billing-attempts Service Bus queue.
 * Deployed as the "worker" Container App (infra/main.bicep, gated behind
 * deployWorker), which scales 0-8 on queue depth via KEDA. It runs the SAME
 * image as the web app — Bicep overrides this container's `command` to
 * `npm run worker` instead of the web app's default CMD, so there's no
 * separate build/push pipeline to maintain.
 *
 * Every message it ever processes was enqueued with an idempotency key
 * derived by idempotency.server.ts, so redelivery, a crash mid-attempt, or
 * two replicas racing on the same message are all safe: see
 * charge.server.ts / store.server.ts for how the actual charge call and its
 * local bookkeeping enforce invariant #1 (never overbill).
 */

import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { processBillingAttemptMessage } from "../lib/billing/charge.server";
import {
  subscribeBillingAttempts,
  subscribeBillingAttemptsDeadLetter,
} from "../lib/billing/queue.server";
import { markDeadLettered } from "../lib/billing/store.server";
import type { AdminClient } from "../lib/selling-plans/api.server";

console.log("[billing-worker] starting");

const subscription = subscribeBillingAttempts({
  handleMessage: async (message) => {
    console.log(
      `[billing-worker] processing ${message.idempotencyKey} (shop=${message.shop}, cycle=${message.billingCycleIndex}, attempt=${message.attemptNumber})`,
    );
    const { admin } = await unauthenticated.admin(message.shop);
    await processBillingAttemptMessage(message, {
      db: prisma,
      admin: admin as unknown as AdminClient,
      now: () => new Date(),
    });
    console.log(`[billing-worker] done ${message.idempotencyKey}`);
  },
  handleError: async (err) => {
    console.error("[billing-worker] receive error", err);
  },
});

// Dead-letter bookkeeping: when Service Bus exhausts redelivery on a
// message, record that on the local row (DEAD_LETTERED) so the attempt
// doesn't sit in the merchant's billing history as forever in flight, then
// complete the DLQ message. The reconciliation sweep and the DLQ metric
// alert (infra/main.bicep) are the other two eyes on this path.
const dlqSubscription = subscribeBillingAttemptsDeadLetter({
  handleMessage: async (message, raw) => {
    const reason =
      [raw.deadLetterReason, raw.deadLetterErrorDescription]
        .filter(Boolean)
        .join(": ") || "dead-lettered by Service Bus";
    if (!message) {
      // Body didn't parse. Log everything we have — this line is the only
      // record once the message is completed. Bodies carry shop/contract/
      // cycle identifiers only, never customer personal data.
      console.error(
        `[billing-worker] DEAD-LETTERED message with unparseable body (${reason}): ${JSON.stringify(raw.body)}`,
      );
      return;
    }
    const { applied } = await markDeadLettered(prisma, message.idempotencyKey, {
      errorMessage: reason,
    });
    console.error(
      `[billing-worker] DEAD-LETTERED ${message.idempotencyKey} (shop=${message.shop}, cycle=${message.billingCycleIndex}) — ${reason}${applied ? "" : " [row already resolved, no state change]"}`,
    );
  },
  handleError: async (err) => {
    console.error("[billing-worker] DLQ receive error", err);
  },
});

function shutdown(signal: string) {
  console.log(`[billing-worker] received ${signal}, shutting down`);
  Promise.allSettled([subscription.close(), dlqSubscription.close()])
    .then((results) => {
      for (const r of results) {
        if (r.status === "rejected") {
          console.error("[billing-worker] error while closing", r.reason);
        }
      }
    })
    .finally(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
