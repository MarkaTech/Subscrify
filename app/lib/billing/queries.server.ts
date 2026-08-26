/**
 * Billing-engine GraphQL operations against the Shopify Admin API.
 * Every operation here is shop-scoped by construction (invariant #2): the
 * admin client passed in comes from either authenticate.admin(request) or
 * unauthenticated.admin(shop), and can only ever act on that one shop.
 *
 * All four operations were validated against the Admin API schema with
 * mcp Shopify validate_graphql_codeblocks before being wired up here — only
 * read_own_subscription_contracts / write_own_subscription_contracts are
 * required, both already granted.
 */

import type { AdminClient } from "../selling-plans/api.server";
import {
  isContractDue,
  pickDueCycle,
  type BillingCycleCandidate,
} from "./scheduler.server";

export interface DueContract {
  gid: string;
  nextBillingDate: string;
}

const DUE_CONTRACTS_QUERY = `#graphql
  query SubscrifyDueContracts($cursor: String) {
    subscriptionContracts(first: 100, after: $cursor, query: "status:ACTIVE") {
      edges {
        cursor
        node {
          id
          status
          nextBillingDate
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

/** All ACTIVE contracts whose nextBillingDate has arrived, across every page. */
export async function fetchDueContracts(
  admin: AdminClient,
  now: Date,
): Promise<DueContract[]> {
  const due: DueContract[] = [];
  let cursor: string | null = null;

  for (;;) {
    const response = await admin.graphql(DUE_CONTRACTS_QUERY, {
      variables: { cursor },
    });
    const json = await response.json();
    const edges = json?.data?.subscriptionContracts?.edges ?? [];

    for (const { node } of edges) {
      if (isContractDue(node, now)) {
        due.push({ gid: node.id, nextBillingDate: node.nextBillingDate });
      }
    }

    const pageInfo = json?.data?.subscriptionContracts?.pageInfo;
    if (!pageInfo?.hasNextPage || edges.length === 0) break;
    cursor = edges[edges.length - 1].cursor;
  }

  return due;
}

const BILLING_CYCLES_QUERY = `#graphql
  query SubscrifyBillingCycles($contractId: ID!, $startDate: DateTime!, $endDate: DateTime!) {
    subscriptionBillingCycles(
      contractId: $contractId
      billingCyclesDateRangeSelector: { startDate: $startDate, endDate: $endDate }
      first: 50
    ) {
      edges {
        node {
          cycleIndex
          billingAttemptExpectedDate
          status
          skipped
        }
      }
    }
  }
`;

/**
 * The earliest due, unbilled, unskipped billing cycle for a contract, or
 * null if there's nothing to charge right now. Looks back far enough to
 * catch a backlog from extended downtime (~13 months) without unbounded
 * lookback on every tick.
 */
export async function fetchDueCycle(
  admin: AdminClient,
  contractGid: string,
  now: Date,
): Promise<BillingCycleCandidate | null> {
  const startDate = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
  const response = await admin.graphql(BILLING_CYCLES_QUERY, {
    variables: {
      contractId: contractGid,
      startDate: startDate.toISOString(),
      endDate: now.toISOString(),
    },
  });
  const json = await response.json();
  const cycles: BillingCycleCandidate[] = (
    json?.data?.subscriptionBillingCycles?.edges ?? []
  ).map(({ node }: any) => node);

  return pickDueCycle(cycles, now);
}

const CONTRACT_STATUS_QUERY = `#graphql
  query SubscrifyContractStatus($id: ID!) {
    subscriptionContract(id: $id) {
      id
      status
    }
  }
`;

/**
 * One contract's current status, straight from Shopify.
 *
 * Used by the manual "bill now" guard (forceBillContractNow). Read live
 * rather than trusting whatever the page was rendered with: a merchant can
 * leave the contract detail tab open, pause the subscription from elsewhere
 * (or a customer can, via the customer portal), and then click "bill now" on
 * a stale page. The status that matters is the one at the moment of the
 * charge decision.
 *
 * Returns null if the contract is missing or the field can't be read, which
 * callers must treat as "not billable" rather than "probably fine".
 */
export async function fetchContractStatus(
  admin: AdminClient,
  contractGid: string,
): Promise<string | null> {
  const response = await admin.graphql(CONTRACT_STATUS_QUERY, {
    variables: { id: contractGid },
  });
  const json = await response.json();
  return json?.data?.subscriptionContract?.status ?? null;
}

/**
 * The earliest UNBILLED, unskipped cycle for a contract, regardless of
 * whether its billingAttemptExpectedDate has arrived yet. Used only by the
 * manual "bill this cycle now" support action (app.contracts.$id.tsx) — the
 * normal scheduled path always goes through fetchDueCycle's date gate.
 * Charging early is still safe: Shopify itself rejects a charge attempted
 * more than 24 hours before the expected date
 * (BILLING_CYCLE_CHARGE_BEFORE_EXPECTED_DATE), and that rejection flows
 * through the same non-retryable-error handling as any other terminal
 * mutation error.
 */
export async function fetchEarliestUnbilledCycle(
  admin: AdminClient,
  contractGid: string,
  now: Date,
): Promise<BillingCycleCandidate | null> {
  const startDate = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
  const endDate = new Date(now.getTime() + 400 * 24 * 60 * 60 * 1000);
  const response = await admin.graphql(BILLING_CYCLES_QUERY, {
    variables: {
      contractId: contractGid,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    },
  });
  const json = await response.json();
  const cycles: BillingCycleCandidate[] = (
    json?.data?.subscriptionBillingCycles?.edges ?? []
  ).map(({ node }: any) => node);

  const unbilled = cycles
    .filter((c) => !c.skipped && c.status === "UNBILLED")
    .sort((a, b) => a.cycleIndex - b.cycleIndex);

  return unbilled[0] ?? null;
}

const CHARGE_BILLING_CYCLE_MUTATION = `#graphql
  mutation SubscrifyChargeBillingCycle($contractId: ID!, $idempotencyKey: String!, $cycleIndex: Int!) {
    subscriptionBillingAttemptCreate(
      subscriptionContractId: $contractId
      subscriptionBillingAttemptInput: {
        idempotencyKey: $idempotencyKey
        billingCycleSelector: { index: $cycleIndex }
      }
    ) {
      subscriptionBillingAttempt {
        id
        idempotencyKey
        createdAt
        completedAt
      }
      userErrors { field message code }
    }
  }
`;

export interface ChargeBillingCycleResult {
  billingAttemptGid: string | null;
  createdAt: string | null;
  completedAt: string | null;
  userErrors: Array<{ field: string[] | null; message: string; code: string | null }>;
}

/**
 * Fire a single billing attempt for one contract-cycle. idempotencyKey MUST
 * come from billingAttemptIdempotencyKey / billingRetryIdempotencyKey — this
 * function does no idempotency-key derivation itself, it only sends what
 * it's given (invariant #1 lives in the caller + that key).
 */
export async function chargeBillingCycle(
  admin: AdminClient,
  params: { contractGid: string; cycleIndex: number; idempotencyKey: string },
): Promise<ChargeBillingCycleResult> {
  const response = await admin.graphql(CHARGE_BILLING_CYCLE_MUTATION, {
    variables: {
      contractId: params.contractGid,
      idempotencyKey: params.idempotencyKey,
      cycleIndex: params.cycleIndex,
    },
  });
  const json = await response.json();
  const payload = json?.data?.subscriptionBillingAttemptCreate;
  const attempt = payload?.subscriptionBillingAttempt;

  return {
    billingAttemptGid: attempt?.id ?? null,
    createdAt: attempt?.createdAt ?? null,
    completedAt: attempt?.completedAt ?? null,
    userErrors: payload?.userErrors ?? [],
  };
}

const BILLING_ATTEMPT_STATE_QUERY = `#graphql
  query SubscrifyBillingAttemptState($id: ID!) {
    subscriptionBillingAttempt(id: $id) {
      id
      state {
        __typename
        ... on SubscriptionBillingAttemptFailedState {
          error {
            __typename
            ... on SubscriptionBillingAttemptGeneralError { generalCode: code }
            ... on SubscriptionBillingAttemptPaymentError { paymentCode: code }
            ... on SubscriptionBillingAttemptInventoryError { inventoryCode: code }
            ... on SubscriptionBillingAttemptUnexpectedError { message }
          }
        }
      }
    }
  }
`;

export type BillingAttemptOutcome =
  | { kind: "pending" }
  | { kind: "success" }
  | { kind: "action_required" }
  | { kind: "failed"; errorCode: string | null; errorMessage: string | null };

/**
 * Ground truth for one billing attempt, straight from Shopify's state union.
 * Used by the reconciliation sweep (reconcile.server.ts) when a local row
 * has sat in flight past the point a webhook should have resolved it —
 * webhooks are delivered at-least-once but not guaranteed if the app was
 * down long enough, and this is the recovery path for that. Returns null
 * when the attempt can't be read (deleted, wrong shop, transient error);
 * callers treat null as "leave the row alone and warn", never as an outcome.
 */
export async function fetchBillingAttemptOutcome(
  admin: AdminClient,
  billingAttemptGid: string,
): Promise<BillingAttemptOutcome | null> {
  const response = await admin.graphql(BILLING_ATTEMPT_STATE_QUERY, {
    variables: { id: billingAttemptGid },
  });
  const json = await response.json();
  const state = json?.data?.subscriptionBillingAttempt?.state;
  if (!state?.__typename) return null;

  switch (state.__typename) {
    case "SubscriptionBillingAttemptPendingState":
      return { kind: "pending" };
    case "SubscriptionBillingAttemptSuccessState":
      return { kind: "success" };
    case "SubscriptionBillingAttemptActionRequiredState":
      return { kind: "action_required" };
    case "SubscriptionBillingAttemptFailedState": {
      const error = state.error ?? {};
      return {
        kind: "failed",
        errorCode:
          error.generalCode ?? error.paymentCode ?? error.inventoryCode ?? null,
        errorMessage: error.message ?? null,
      };
    }
    default:
      // A state Shopify adds later — don't guess what it means for money.
      return null;
  }
}

const GET_BILLING_ATTEMPT_QUERY = `#graphql
  query SubscrifyGetBillingAttempt($id: ID!) {
    subscriptionBillingAttempt(id: $id) {
      id
      idempotencyKey
      completedAt
      subscriptionContract { id }
    }
  }
`;

export interface BillingAttemptLookup {
  gid: string;
  idempotencyKey: string;
  completedAt: string | null;
  subscriptionContractGid: string;
}

/**
 * Fallback correlation path for webhook handlers: if a billing-attempt
 * webhook payload doesn't carry idempotency_key directly (payload shape for
 * this resource isn't documented in detail), re-fetch the attempt by its GID
 * to get the authoritative idempotency key and contract back.
 */
export async function fetchBillingAttempt(
  admin: AdminClient,
  billingAttemptGid: string,
): Promise<BillingAttemptLookup | null> {
  const response = await admin.graphql(GET_BILLING_ATTEMPT_QUERY, {
    variables: { id: billingAttemptGid },
  });
  const json = await response.json();
  const node = json?.data?.subscriptionBillingAttempt;
  if (!node) return null;

  return {
    gid: node.id,
    idempotencyKey: node.idempotencyKey,
    completedAt: node.completedAt ?? null,
    subscriptionContractGid: node.subscriptionContract.id,
  };
}
