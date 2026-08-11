/**
 * Contract lifecycle rules — pure, no Shopify client, no server-only imports.
 *
 * Deliberately separate from lifecycle.server.ts: the contract detail
 * component calls allowedActions() to decide which buttons to render, and the
 * route action calls it again to re-check server-side. A `.server` module
 * can't be imported from component code — React Router only strips server
 * code from `loader`/`action`/`headers`, so importing one anywhere else fails
 * the production build. Same split as selling-plans/program.ts vs
 * api.server.ts.
 *
 * Keeping the rule in one place is the point: the buttons a merchant sees and
 * the actions the server will accept are derived from the same function, so
 * they cannot drift apart.
 */

/** Statuses we act on. Shopify's own enum is wider; anything else fails closed. */
export type ContractLifecycleStatus = "ACTIVE" | "PAUSED" | "CANCELLED" | string;

export type LifecycleAction = "pause" | "resume" | "cancel";

/**
 * Which lifecycle actions make sense from a given status.
 *
 * CANCELLED is terminal in Shopify — a cancelled contract cannot be
 * reactivated — so nothing is allowed from there. Unrecognised statuses
 * (EXPIRED, FAILED, anything Shopify adds later) also return nothing rather
 * than being guessed at: offering an action that silently fails, or worse
 * that succeeds when it shouldn't, is worse than offering none.
 */
export function allowedActions(status: ContractLifecycleStatus): LifecycleAction[] {
  switch (status) {
    case "ACTIVE":
      return ["pause", "cancel"];
    case "PAUSED":
      return ["resume", "cancel"];
    default:
      return [];
  }
}

export function isActionAllowed(
  status: ContractLifecycleStatus,
  action: LifecycleAction,
): boolean {
  return allowedActions(status).includes(action);
}

/** Past-tense phrasing for merchant-facing messages ("can no longer be paused"). */
export function actionPastTense(action: LifecycleAction): string {
  return action === "resume" ? "resumed" : `${action}d`;
}
