import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listContracts } from "../lib/contracts/api.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const contracts = await listContracts(admin);
  return { contracts };
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function ContractsIndex() {
  const { contracts } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Subscriptions">
      {contracts.length === 0 ? (
        <s-section heading="No subscriptions yet">
          <s-paragraph>
            When a buyer subscribes at checkout, the contract appears here.
            Make sure a program has products attached so buyers see plan
            options on the product page.
          </s-paragraph>
        </s-section>
      ) : (
        <s-section heading={`${contracts.length} subscription(s)`}>
          <s-table>
            <s-table-header-row>
              <s-table-header>Contract</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Items</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Next billing</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {contracts.map((c) => (
                <s-table-row key={c.id}>
                  <s-table-cell>
                    <Link to={`/app/contracts/${c.numericId}`}>#{c.numericId}</Link>
                  </s-table-cell>
                  <s-table-cell>{c.customerName}</s-table-cell>
                  <s-table-cell>{c.lineSummary}</s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={c.status === "ACTIVE" ? "success" : c.status === "CANCELLED" ? "critical" : "warning"}
                    >
                      {c.status}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{formatDate(c.nextBillingDate)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
