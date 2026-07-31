import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getContract } from "../lib/contracts/api.server";
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
  const { session, admin } = await authenticate.admin(request);
  const gid = contractGidFromParam(params.id);
  const contract = gid ? await getContract(admin, gid) : null;
  if (!contract || !gid) {
    throw new Response("Subscription not found", { status: 404 });
  }
  const billingAttempts = await listAttemptsForContract(db, session.shop, gid);
  return { contract, billingAttempts };
};

/**
 * "Bill this cycle now" — a merchant-support action (Phase 4 billing
 * engine). Goes through the real scheduler → Service Bus → worker path
 * (see forceBillContractNow's doc comment), not a special-cased shortcut.
 */
export const action = async ({ params, request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const gid = contractGidFromParam(params.id);
  if (!gid) {
    throw new Response("Subscription not found", { status: 404 });
  }
  const result = await forceBillContractNow(db, admin, session.shop, gid);
  return { result };
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
    default:
      return "info";
  }
}

export default function ContractDetail() {
  const { contract, billingAttempts } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data?.result;

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
        <s-button
          variant="secondary"
          {...(fetcher.state !== "idle" ? { loading: true } : {})}
          onClick={() => fetcher.submit(null, { method: "post" })}
        >
          Bill next unbilled cycle now
        </s-button>
        {result ? (
          <s-paragraph>
            {result.outcome === "enqueued" && `Enqueued cycle ${result.cycleIndex} for charging.`}
            {result.outcome === "already_in_flight" &&
              `Cycle ${result.cycleIndex} is already enqueued or in progress.`}
            {result.outcome === "nothing_to_bill" && "Nothing unbilled to charge right now."}
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
