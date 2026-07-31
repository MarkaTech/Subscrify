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
import { subscribeBillingAttempts } from "../lib/billing/queue.server";
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

function shutdown(signal: string) {
  console.log(`[billing-worker] received ${signal}, shutting down`);
  subscription
    .close()
    .catch((e) => console.error("[billing-worker] error while closing", e))
    .finally(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
