import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getContract } from "../lib/contracts/api.server";
import {
  actionPastTense,
  allowedActions,
  isActionAllowed,
  type LifecycleAction,
} from "../lib/contracts/lifecycle";
import { runLifecycleAction } from "../lib/contracts/lifecycle.server";
import {
  actorFromSessionToken,
  logPersonalDataAccess,
  type ProtectedField,
} from "../lib/audit/access-log.server";
import { forceBillContractNow } from "../lib/billing/run-scheduler.server";
import { listAttemptsForContract } from "../lib/billing/store.server";
import db from "../db.server";

/** URL param is the numeric contract id (encoded slashes in a full gid get
 *  decoded by the ingress proxy and break route matching). */
function contractGidFromParam(id: string | undefined): string | null {
  if (!id) return null;
  if (/^\d+$/.test(id)) return `gid://shopify/SubscriptionContract/${id}`;
  return null;
}

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { session, admin, sessionToken } = await authenticate.admin(request);
  const gid = contractGidFromParam(params.id);
  const contract = gid ? await getContract(admin, gid) : null;
  if (!contract || !gid) {
    throw new Response("Subscription not found", { status: 404 });
  }

  // This page displays the subscriber's name and (when granted) email, so
  // loading it is an access to protected customer data. Record which fields
  // were actually shown — email is absent unless Protected Customer Data
  // approval covers it — never their values.
  const fields: ProtectedField[] = ["name"];
  if (contract.customerEmail) fields.push("email");
  logPersonalDataAccess({
    shop: session.shop,
    actorUserId: actorFromSessionToken(sessionToken),
    resource: "contract_detail",
    contractGid: gid,
    recordCount: 1,
    fields,
  });

  const billingAttempts = await listAttemptsForContract(db, session.shop, gid);
  return { contract, billingAttempts };
};

const LIFECYCLE_INTENTS = new Set<LifecycleAction>(["pause", "resume", "cancel"]);

/**
 * Two kinds of action share this route:
 *   - "bill"                     — the Phase 4 merchant-support charge trigger
 *   - pause / resume / cancel    — Phase 5 lifecycle
 *
 * Lifecycle actions re-read the contract's current status server-side and
 * re-check it against allowedActions before mutating. The buttons are already
 * conditioned on status, but a page can sit open while the contract changes
 * elsewhere — another staff member, or the customer via the customer portal —
 * and a stale button must not be able to drive a cancel the merchant no
 * longer means.
 */
export const action = async ({ params, request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const gid = contractGidFromParam(params.id);
  if (!gid) {
    throw new Response("Subscription not found", { status: 404 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "bill");

  if (LIFECYCLE_INTENTS.has(intent as LifecycleAction)) {
    const wanted = intent as LifecycleAction;
    const current = await getContract(admin, gid);
    if (!current) {
      throw new Response("Subscription not found", { status: 404 });
    }
    if (!isActionAllowed(current.status, wanted)) {
      return {
        lifecycle: {
          ok: false,
          error: `This subscription is ${current.status}, so it can no longer be ${actionPastTense(
            wanted,
          )}. Refresh to see its current state.`,
        },
        action: wanted,
      };
    }
    const lifecycle = await runLifecycleAction(admin, gid, wanted);
    return { lifecycle, action: wanted };
  }

  try {
    const result = await forceBillContractNow(db, admin, session.shop, gid);
    return { result };
  } catch (e: any) {
    // A transient Shopify/API failure must degrade to a message, never to
    // the route's error boundary — this action charges money, and "the page
    // exploded" tells the merchant nothing about whether anything happened.
    // (This exact path crashed in live testing on 2026-08-26 when the old
    // date-window cycle query drew a top-level GraphQL error and
    // admin.graphql threw.) Log the message for Log Analytics; no payloads.
    console.error(
      `[bill-now] failed for ${gid} on ${session.shop}: ${e?.message ?? e}`,
    );
    return { result: { outcome: "error" as const } };
  }
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(iso: string | Date | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function policyText(p: { interval: string; intervalCount: number } | null): string {
  if (!p) return "—";
  const unit = p.interval.toLowerCase();
  return p.intervalCount === 1 ? `Every ${unit}` : `Every ${p.intervalCount} ${unit}s`;
}

function attemptTone(status: string): "success" | "critical" | "warning" | "info" {
  switch (status) {
    case "SUCCEEDED":
      return "success";
    case "FAILED":
    case "DEAD_LETTERED":
      return "critical";
    case "REQUIRES_ACTION":
      return "warning";
    case "SKIPPED":
      return "info";
    default:
      return "info";
  }
}

export default function ContractDetail() {
  const { contract, billingAttempts } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data?.result;
  const lifecycle = fetcher.data?.lifecycle;
  const lifecycleAction = fetcher.data?.action;
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const busy = fetcher.state !== "idle";
  const actions = allowedActions(contract.status);
  const submit = (intent: LifecycleAction) =>
    fetcher.submit({ intent }, { method: "post" });

  return (
    <s-page heading={`Subscription #${contract.numericId}`}>
      <s-section heading="Status">
        <s-badge
          tone={contract.status === "ACTIVE" ? "success" : contract.status === "CANCELLED" ? "critical" : "warning"}
        >
          {contract.status}
        </s-badge>
        <s-paragraph>Created {formatDate(contract.createdAt)}</s-paragraph>
        <s-paragraph>Next billing: {formatDate(contract.nextBillingDate)}</s-paragraph>
        {contract.lastPaymentStatus ? (
          <s-paragraph>Last payment: {contract.lastPaymentStatus}</s-paragraph>
        ) : null}
        {contract.originOrderName ? (
          <s-paragraph>Origin order: {contract.originOrderName}</s-paragraph>
        ) : null}

        {lifecycle ? (
          <s-banner tone={lifecycle.ok ? "success" : "critical"}>
            <s-paragraph>
              {lifecycle.ok
                ? lifecycleAction === "pause"
                  ? "Subscription paused. No further renewals will be charged until it's resumed."
                  : lifecycleAction === "resume"
                    ? "Subscription resumed. Renewals will charge on schedule again."
                    : "Subscription cancelled. It will not be charged again."
                : lifecycle.error}
            </s-paragraph>
          </s-banner>
        ) : null}

        {/* Never nest s-button inside s-link — the shadow-DOM button swallows
            the click and the control goes dead (see a91bdb4). */}
        {actions.includes("pause") ? (
          <s-button
            variant="secondary"
            {...(busy ? { loading: true } : {})}
            onClick={() => submit("pause")}
          >
            Pause subscription
          </s-button>
        ) : null}

        {actions.includes("resume") ? (
          <s-button
            variant="secondary"
            {...(busy ? { loading: true } : {})}
            onClick={() => submit("resume")}
          >
            Resume subscription
          </s-button>
        ) : null}

        {/* Cancelling is irreversible in Shopify — a cancelled contract cannot
            be reactivated — so it takes a second, explicit confirmation rather
            than firing on one click. */}
        {actions.includes("cancel") ? (
          confirmingCancel ? (
            <>
              <s-paragraph>
                Cancel this subscription permanently? It can&rsquo;t be resumed
                afterwards — the customer would have to subscribe again.
              </s-paragraph>
              <s-button
                variant="primary"
                tone="critical"
                {...(busy ? { loading: true } : {})}
                onClick={() => {
                  setConfirmingCancel(false);
                  submit("cancel");
                }}
              >
                Yes, cancel permanently
              </s-button>
              <s-button variant="tertiary" onClick={() => setConfirmingCancel(false)}>
                Keep subscription
              </s-button>
            </>
          ) : (
            <s-button
              variant="secondary"
              tone="critical"
              onClick={() => setConfirmingCancel(true)}
            >
              Cancel subscription
            </s-button>
          )
        ) : null}

        {actions.length === 0 ? (
          <s-paragraph>
            No further changes are possible for a {contract.status.toLowerCase()}{" "}
            subscription.
          </s-paragraph>
        ) : null}
      </s-section>

      <s-section heading="Customer">
        <s-paragraph>{contract.customerName}</s-paragraph>
        {contract.customerEmail ? <s-paragraph>{contract.customerEmail}</s-paragraph> : null}
      </s-section>

      <s-section heading="Schedule">
        <s-paragraph>Delivery: {policyText(contract.deliveryPolicy)}</s-paragraph>
        <s-paragraph>Billing: {policyText(contract.billingPolicy)}</s-paragraph>
      </s-section>

      <s-section heading="Items">
        <s-table>
          <s-table-header-row>
            <s-table-header>Item</s-table-header>
            <s-table-header>Qty</s-table-header>
            <s-table-header>Price</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {contract.lines.map((line, i) => (
              <s-table-row key={i}>
                <s-table-cell>
                  {line.title}
                  {line.variantTitle && line.variantTitle !== line.title
                    ? ` — ${line.variantTitle}`
                    : ""}
                </s-table-cell>
                <s-table-cell>{line.quantity}</s-table-cell>
                <s-table-cell>
                  {line.price} {line.currency}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      <s-section heading="Billing">
        {/* Only offered while the contract is actually billable. The server
            enforces this too (forceBillContractNow's status guard) — hiding
            the button is the courtesy, not the control. */}
        {contract.status === "ACTIVE" ? (
          <s-button
            variant="secondary"
            {...(busy ? { loading: true } : {})}
            onClick={() => fetcher.submit({ intent: "bill" }, { method: "post" })}
          >
            Bill next unbilled cycle now
          </s-button>
        ) : (
          <s-paragraph>
            {contract.status === "PAUSED"
              ? "Paused subscriptions aren't charged. Resume it to bill again."
              : `A ${contract.status.toLowerCase()} subscription can't be charged.`}
          </s-paragraph>
        )}
        {result ? (
          <s-paragraph>
            {result.outcome === "enqueued" && `Enqueued cycle ${result.cycleIndex} for charging.`}
            {result.outcome === "already_in_flight" &&
              `Cycle ${result.cycleIndex} is already enqueued or in progress.`}
            {result.outcome === "nothing_to_bill" && "Nothing unbilled to charge right now."}
            {result.outcome === "not_billable" &&
              `This subscription is ${result.status} and was not charged.`}
            {result.outcome === "error" &&
              "Couldn't reach Shopify to check this subscription's billing cycles. Nothing was charged — try again in a moment."}
          </s-paragraph>
        ) : null}

        {billingAttempts.length > 0 ? (
          <s-table>
            <s-table-header-row>
              <s-table-header>Cycle</s-table-header>
              <s-table-header>Attempt</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Error</s-table-header>
              <s-table-header>Updated</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {billingAttempts.map((a) => (
                <s-table-row key={a.id}>
                  <s-table-cell>{a.billingCycleIndex}</s-table-cell>
                  <s-table-cell>{a.attemptNumber}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={attemptTone(a.status)}>{a.status}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{a.errorCode ?? "—"}</s-table-cell>
                  <s-table-cell>{formatDateTime(a.updatedAt)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-paragraph>No billing attempts recorded yet.</s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
