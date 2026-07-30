/**
 * Invariant #1 — never overbill.
 *
 * Every recurring charge Subscrify ever makes goes through Shopify's
 * billing-attempt mutations carrying an idempotency key produced by this
 * module. The key is derived deterministically from (shop, contract, billing
 * cycle), so a retried or duplicated job can never double-charge a cycle:
 * Shopify rejects the second attempt with the same key.
 *
 * Rules:
 * - One key per (shop, contract, cycle). Never include timestamps, job IDs,
 *   attempt counters, or random values — those would defeat idempotency.
 * - Dunning retries for the SAME cycle reuse the SAME key only when retrying
 *   a failed attempt is done via a new billing attempt; Shopify treats a new
 *   attempt for a failed cycle as chargeable, so retries append the attempt
 *   number explicitly and deliberately (see dunning engine, Phase 4) — never
 *   implicitly.
 */

const KEY_VERSION = "v1";

export interface BillingCycleRef {
  /** myshopify domain, e.g. "subscrify-test.myshopify.com" (invariant #2: shop-scoped) */
  shop: string;
  /** Admin API GID, e.g. "gid://shopify/SubscriptionContract/123" */
  subscriptionContractGid: string;
  /** Shopify billing cycle index (>= 1) of the cycle being charged */
  billingCycleIndex: number;
}

export function billingAttemptIdempotencyKey(ref: BillingCycleRef): string {
  const shop = ref.shop.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    throw new Error(`billing idempotency key: invalid shop "${ref.shop}"`);
  }

  const contractId = numericIdFromGid(ref.subscriptionContractGid);

  if (
    !Number.isInteger(ref.billingCycleIndex) ||
    ref.billingCycleIndex < 1
  ) {
    throw new Error(
      `billing idempotency key: invalid billing cycle index "${ref.billingCycleIndex}"`,
    );
  }

  return `subscrify-${KEY_VERSION}-${shop}-${contractId}-${ref.billingCycleIndex}`;
}

function numericIdFromGid(gid: string): string {
  const match = /^gid:\/\/shopify\/SubscriptionContract\/(\d+)$/.exec(gid);
  if (!match) {
    throw new Error(
      `billing idempotency key: expected a SubscriptionContract GID, got "${gid}"`,
    );
  }
  return match[1];
}
