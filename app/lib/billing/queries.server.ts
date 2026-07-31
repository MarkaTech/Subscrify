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
