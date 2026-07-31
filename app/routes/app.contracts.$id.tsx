import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getContract } from "../lib/contracts/api.server";

/** URL param is the numeric contract id (encoded slashes in a full gid get
 *  decoded by the ingress proxy and break route matching). */
function contractGidFromParam(id: string | undefined): string | null {
  if (!id) return null;
  if (/^\d+$/.test(id)) return `gid://shopify/SubscriptionContract/${id}`;
  return null;
}

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const gid = contractGidFromParam(params.id);
  const contract = gid ? await getContract(admin, gid) : null;
  if (!contract) {
    throw new Response("Subscription not found", { status: 404 });
  }
  return { contract };
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function policyText(p: { interval: string; intervalCount: number } | null): string {
  if (!p) return "—";
  const unit = p.interval.toLowerCase();
  return p.intervalCount === 1 ? `Every ${unit}` : `Every ${p.intervalCount} ${unit}s`;
}

export default function ContractDetail() {
  const { contract } = useLoaderData<typeof loader>();

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
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
