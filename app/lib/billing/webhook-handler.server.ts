/**
 * subscription_billing_attempts/* webhook handling — Phase 4 billing engine.
 *
 * Shopify's exact JSON payload shape for this resource isn't documented in
 * enough detail to trust field names blindly, so correlation tries the field
 * we'd expect (idempotency_key) and falls back to re-fetching the billing
 * attempt by GID over GraphQL — either path lands on the same authoritative
 * idempotency key, which is what everything else in this engine keys off of.
 *
 * The three webhook routes (success/failure/challenged) are thin wrappers
 * around handleBillingAttemptWebhook so the correlation + dunning logic
 * lives in exactly one place.
 */

import type { ActionFunctionArgs } from "react-router";
import type { PrismaClient } from "@prisma/client";
import type { AdminClient } from "../selling-plans/api.server";
import { authenticate } from "../../shopify.server";
import db from "../../db.server";
import { fetchBillingAttempt } from "./queries.server";
import { findByIdempotencyKey, markSucceeded } from "./store.server";
import {
  applyFailureRecovery,
  planFailureRecovery,
  type FailureContext,
} from "./charge.server";

export type BillingWebhookTopic = "success" | "failure" | "challenged";

export interface WebhookHandlerResult {
  handled: boolean;
  reason?: string;
}

export async function resolveIdempotencyKeyFromWebhook(
  admin: AdminClient,
  payload: Record<string, unknown>,
): Promise<string | null> {
  const direct = payload.idempotency_key;
  if (typeof direct === "string" && direct.length > 0) return direct;

  const gid =
    (typeof payload.admin_graphql_api_id === "string" &&
      payload.admin_graphql_api_id) ||
    (typeof payload.id === "string" &&
      payload.id.startsWith("gid://") &&
      payload.id) ||
    null;
  if (!gid) return null;

  const attempt = await fetchBillingAttempt(admin, gid as string);
  return attempt?.idempotencyKey ?? null;
}

export async function handleBillingAttemptWebhook(
  db: PrismaClient,
  admin: AdminClient,
  topic: BillingWebhookTopic,
  payload: Record<string, unknown>,
  now: Date = new Date(),
): Promise<WebhookHandlerResult> {
  const idempotencyKey = await resolveIdempotencyKeyFromWebhook(admin, payload);
  if (!idempotencyKey) {
    return {
      handled: false,
      reason: "could not correlate webhook payload to an idempotency key",
    };
  }

  const row = await findByIdempotencyKey(db, idempotencyKey);
  if (!row) {
    return {
      handled: false,
      reason: `no local BillingCycleAttempt row for idempotency key "${idempotencyKey}"`,
    };
  }

  if (topic === "success") {
    await markSucceeded(db, idempotencyKey, {
      shopifyBillingAttemptGid: row.shopifyBillingAttemptGid,
    });
    return { handled: true };
  }

  const ctx: FailureContext = {
    shop: row.shop,
    subscriptionContractGid: row.subscriptionContractGid,
    billingCycleIndex: row.billingCycleIndex,
    attemptNumber: row.attemptNumber,
    idempotencyKey,
  };

  const errorCode = typeof payload.error_code === "string" ? payload.error_code : null;
  const errorMessage =
    typeof payload.error_message === "string" ? payload.error_message : null;

  const plan = planFailureRecovery(
    ctx,
    {
      errorCode,
      errorMessage,
      requiresAction: topic === "challenged",
      // Async outcomes (a real payment attempt that Shopify actually ran)
      // always get a dunning chance, unlike the worker's synchronous
      // mutation-userErrors path, which pre-filters by error code — see
      // dunning.server.ts's isRetryableMutationError.
      retryable: true,
    },
    now,
  );

  await applyFailureRecovery(db, ctx, plan);
  return { handled: true };
}

/**
 * Builds the `action` export for a subscription_billing_attempts/<topic>
 * webhook route — all three (success/failure/challenged) are otherwise
 * identical, so the route files are one line each.
 */
export function createBillingAttemptWebhookAction(topic: BillingWebhookTopic) {
  return async function action({ request }: ActionFunctionArgs) {
    const { shop, session, admin, payload, topic: shopifyTopic } =
      await authenticate.webhook(request);
    console.log(`Received ${shopifyTopic} webhook for ${shop}`);

    if (!session || !admin) {
      // App likely uninstalled between the charge attempt and this webhook
      // arriving — nothing local to reconcile against for a shop with no
      // session, and no admin client to correlate the payload with either.
      console.warn(`[webhooks] ${shopifyTopic}: no session/admin for ${shop}, skipping`);
      return new Response();
    }

    const result = await handleBillingAttemptWebhook(
      db,
      admin as unknown as AdminClient,
      topic,
      payload as Record<string, unknown>,
    );
    if (!result.handled) {
      console.warn(`[webhooks] ${shopifyTopic} not handled: ${result.reason}`);
    }

    return new Response();
  };
}
