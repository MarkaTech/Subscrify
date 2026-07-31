/**
 * Subscription contract reads against the Shopify Admin API.
 * Shop-scoped by construction (invariant #2): the admin client from
 * authenticate.admin can only act on the authenticated shop, and
 * subscriptionContracts only ever returns contracts owned by this app.
 */

import type { AdminClient } from "../selling-plans/api.server";

export interface ContractLine {
  title: string;
  variantTitle: string | null;
  quantity: number;
  price: string;
  currency: string;
}

export interface ContractSummary {
  id: string;
  numericId: string;
  status: string;
  createdAt: string;
  nextBillingDate: string | null;
  customerName: string;
  customerEmail: string | null;
  lineSummary: string;
}

export interface ContractDetail extends ContractSummary {
  deliveryPolicy: { interval: string; intervalCount: number } | null;
  billingPolicy: { interval: string; intervalCount: number } | null;
  lines: ContractLine[];
  originOrderName: string | null;
  originOrderId: string | null;
  lastPaymentStatus: string | null;
}

const CONTRACT_FIELDS = `#graphql
  fragment ContractFields on SubscriptionContract {
    id
    status
    createdAt
    nextBillingDate
    customer { displayName email }
    deliveryPolicy { interval intervalCount }
    billingPolicy { interval intervalCount }
    lines(first: 10) {
      edges {
        node {
          title
          variantTitle
          quantity
          currentPrice { amount currencyCode }
        }
      }
    }
  }
`;

function numericId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

function toSummary(node: any): ContractSummary {
  const lines = (node.lines?.edges ?? []).map(({ node: l }: any) => l);
  const first = lines[0];
  const lineSummary = first
    ? `${first.title}${lines.length > 1 ? ` +${lines.length - 1} more` : ""}`
    : "—";
  return {
    id: node.id,
    numericId: numericId(node.id),
    status: node.status,
    createdAt: node.createdAt,
    nextBillingDate: node.nextBillingDate ?? null,
    customerName: node.customer?.displayName ?? "—",
    customerEmail: node.customer?.email ?? null,
    lineSummary,
  };
}

export async function listContracts(admin: AdminClient): Promise<ContractSummary[]> {
  const response = await admin.graphql(
    `#graphql
    ${CONTRACT_FIELDS}
    query subscrifyContracts {
      subscriptionContracts(first: 50, reverse: true) {
        edges { node { ...ContractFields } }
      }
    }`,
  );
  const json = await response.json();
  const edges = json?.data?.subscriptionContracts?.edges ?? [];
  return edges.map(({ node }: any) => toSummary(node));
}

export async function getContract(
  admin: AdminClient,
  id: string,
): Promise<ContractDetail | null> {
  const response = await admin.graphql(
    `#graphql
    ${CONTRACT_FIELDS}
    query subscrifyGetContract($id: ID!) {
      subscriptionContract(id: $id) {
        ...ContractFields
        originOrder { id name }
        lastPaymentStatus
      }
    }`,
    { variables: { id } },
  );
  const json = await response.json();
  const node = json?.data?.subscriptionContract;
  if (!node) return null;
  const summary = toSummary(node);
  return {
    ...summary,
    deliveryPolicy: node.deliveryPolicy ?? null,
    billingPolicy: node.billingPolicy ?? null,
    lines: (node.lines?.edges ?? []).map(({ node: l }: any) => ({
      title: l.title,
      variantTitle: l.variantTitle ?? null,
      quantity: l.quantity,
      price: l.currentPrice?.amount ?? "",
      currency: l.currentPrice?.currencyCode ?? "",
    })),
    originOrderName: node.originOrder?.name ?? null,
    originOrderId: node.originOrder?.id ?? null,
    lastPaymentStatus: node.lastPaymentStatus ?? null,
  };
}
