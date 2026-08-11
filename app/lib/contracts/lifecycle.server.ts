/**
 * Contract lifecycle — pause, resume, cancel (Phase 5).
 *
 * Shop-scoping (invariant #2) is enforced by construction: the admin client
 * passed in comes from authenticate.admin(request), so it can only ever act
 * on that one shop's contracts. There is no contract-to-shop lookup here to
 * get wrong.
 *
 * All three mutations were validated against the Admin API schema with
 * validate_graphql_codeblocks before being wired up. Each needs only
 * write_own_subscription_contracts / read_own_subscription_contracts, both
 * already granted.
 *
 * Relationship to invariant #1 (never overbill): pausing is not merely a
 * label. The scheduler only ever looks at contracts Shopify reports as
 * ACTIVE (see queries.server.ts DUE_CONTRACTS_QUERY + scheduler.isContractDue),
 * so a paused contract drops out of the billing path entirely. The manual
 * "bill now" support action is guarded separately in
 * run-scheduler.server.ts — see the status guard in forceBillContractNow.
 */

import type { AdminClient } from "../selling-plans/api.server";

import type { ContractLifecycleStatus, LifecycleAction } from "./lifecycle";

export type { ContractLifecycleStatus, LifecycleAction } from "./lifecycle";
export { allowedActions, isActionAllowed, actionPastTense } from "./lifecycle";

export interface LifecycleResult {
  ok: boolean;
  /** Contract status after the mutation, when Shopify returned one. */
  status?: ContractLifecycleStatus;
  /** Merchant-readable failure reason. Present iff ok is false. */
  error?: string;
}

const PAUSE_MUTATION = `#graphql
  mutation SubscrifyPauseContract($contractId: ID!) {
    subscriptionContractPause(subscriptionContractId: $contractId) {
      contract { id status }
      userErrors { field message }
    }
  }
`;

const ACTIVATE_MUTATION = `#graphql
  mutation SubscrifyActivateContract($contractId: ID!) {
    subscriptionContractActivate(subscriptionContractId: $contractId) {
      contract { id status }
      userErrors { field message }
    }
  }
`;

const CANCEL_MUTATION = `#graphql
  mutation SubscrifyCancelContract($contractId: ID!) {
    subscriptionContractCancel(subscriptionContractId: $contractId) {
      contract { id status }
      userErrors { field message }
    }
  }
`;

const MUTATIONS: Record<LifecycleAction, { doc: string; root: string; verb: string }> = {
  pause: { doc: PAUSE_MUTATION, root: "subscriptionContractPause", verb: "pause" },
  resume: { doc: ACTIVATE_MUTATION, root: "subscriptionContractActivate", verb: "resume" },
  cancel: { doc: CANCEL_MUTATION, root: "subscriptionContractCancel", verb: "cancel" },
};

/**
 * Run a lifecycle mutation. Returns a result rather than throwing, because
 * every caller is a route action that wants to re-render the page with a
 * message — an unhandled throw would give the merchant a blank error boundary
 * instead of "couldn't pause this, here's why".
 */
export async function runLifecycleAction(
  admin: AdminClient,
  contractGid: string,
  action: LifecycleAction,
): Promise<LifecycleResult> {
  const { doc, root, verb } = MUTATIONS[action];

  let payload: any;
  try {
    const response = await admin.graphql(doc, {
      variables: { contractId: contractGid },
    });
    payload = await response.json();
  } catch (e: any) {
    return { ok: false, error: `Could not ${verb} this subscription: ${e?.message ?? String(e)}` };
  }

  // A transport-level GraphQL error (bad scope, throttle, malformed id) shows
  // up here rather than in userErrors.
  const topLevel = payload?.errors;
  if (Array.isArray(topLevel) && topLevel.length > 0) {
    return { ok: false, error: topLevel.map((e: any) => e?.message).filter(Boolean).join("; ") };
  }

  const result = payload?.data?.[root];
  const userErrors = result?.userErrors ?? [];
  if (userErrors.length > 0) {
    return {
      ok: false,
      error: userErrors.map((e: any) => e?.message).filter(Boolean).join("; "),
    };
  }

  // No errors but no contract back either — treat as a failure rather than
  // reporting success we can't evidence.
  if (!result?.contract?.status) {
    return { ok: false, error: `Shopify did not confirm the ${verb}. Refresh to check the current status.` };
  }

  return { ok: true, status: result.contract.status };
}
