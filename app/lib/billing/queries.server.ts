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

/**
 * Cycles are fetched by INDEX range in small rolling windows. Both halves of
 * that sentence are load-bearing, learned from live failures on 2026-08-26:
 *
 * 1. Shopify enforces "you can query up to one year of billing cycles after
 *    the last time you updated or billed the contract" (billing-cycles docs,
 *    Limitations). A selector that reaches past that — the old 800-day DATE
 *    window, or a greedy index range like 1..1000 — fails with the top-level
 *    GraphQL error "Upcoming billing cycle selected past limit.", and
 *    admin.graphql THROWS on top-level errors. The manual bill-now action
 *    crashed exactly this way, twice, once per selector style.
 *
 * 2. Small windows sidestep the limit *by construction*: a window of
 *    CYCLES_WINDOW cycles spans at most CYCLES_WINDOW billing intervals,
 *    far less than a year of cycles for every interval the app sells; and
 *    the earliest UNBILLED cycle always sits within one interval of the
 *    last-billed cycle, i.e. safely inside the queryable year — so walking
 *    windows from index 1 and stopping at the first unbilled cycle finds it
 *    before any window can cross the limit. If a window does cross it
 *    (every earlier cycle billed and the search has run out of queryable
 *    future), that error is treated as end-of-search, not a crash.
 *
 * Every date decision (is the cycle due?) stays client-side in
 * scheduler.server.ts's pickDueCycle, unchanged.
 */
const BILLING_CYCLES_BY_INDEX_QUERY = `#graphql
  query SubscrifyBillingCyclesByIndex($contractId: ID!, $startIndex: Int!, $endIndex: Int!, $first: Int!) {
    subscriptionBillingCycles(
      contractId: $contractId
      billingCyclesIndexRangeSelector: { startIndex: $startIndex, endIndex: $endIndex }
      first: $first
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

const CYCLES_WINDOW = 36;
const CYCLES_MAX_WINDOWS = 7; // 252 cycles ≈ 21 years of a monthly plan

function isPastLimitError(e: unknown): boolean {
  const message =
    (e as any)?.message ??
    (typeof e === "string" ? e : "");
  return /past limit/i.test(String(message));
}

/**
 * A contract's billing cycles from index 1, ascending, stopping at the
 * window that contains the first unbilled cycle (or at Shopify's
 * one-year-ahead query limit, whichever comes first).
 */
async function fetchCyclesFromStart(
  admin: AdminClient,
  contractGid: string,
): Promise<BillingCycleCandidate[]> {
  const cycles: BillingCycleCandidate[] = [];

  for (let w = 0; w < CYCLES_MAX_WINDOWS; w += 1) {
    const startIndex = 1 + w * CYCLES_WINDOW;
    const endIndex = startIndex + CYCLES_WINDOW - 1;

    let edges: Array<{ node: BillingCycleCandidate }>;
    try {
      const response = await admin.graphql(BILLING_CYCLES_BY_INDEX_QUERY, {
        variables: {
          contractId: contractGid,
          startIndex,
          endIndex,
          first: CYCLES_WINDOW,
        },
      });
      const json = await response.json();
      edges = json?.data?.subscriptionBillingCycles?.edges ?? [];
    } catch (e) {
      // The window reached past Shopify's queryable year. Whatever was
      // collected so far is the complete answerable set — see the module
      // comment for why the first unbilled cycle can never be out here.
      if (isPastLimitError(e)) break;
      throw e;
    }

    for (const { node } of edges) cycles.push(node);

    const foundUnbilled = edges.some(
      ({ node }) => node.status === "UNBILLED" && !node.skipped,
    );
    if (foundUnbilled || edges.length < CYCLES_WINDOW) break;
  }

  return cycles;
}

/**
 * The earliest due, unbilled, unskipped billing cycle for a contract, or
 * null if there's nothing to charge right now.
 */
export async function fetchDueCycle(
  admin: AdminClient,
  contractGid: string,
  now: Date,
): Promise<BillingCycleCandidate | null> {
  const cycles = await fetchCyclesFromStart(admin, contractGid);
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
 *
 * `now` is unused since the index-range rewrite (see
 * BILLING_CYCLES_BY_INDEX_QUERY) but kept in the signature so callers keep
 * passing their clock — a future date-based refinement shouldn't need a
 * call-site change.
 */
export async function fetchEarliestUnbilledCycle(
  admin: AdminClient,
  contractGid: string,
  _now: Date,
): Promise<BillingCycleCandidate | null> {
  const cycles = await fetchCyclesFromStart(admin, contractGid);
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
