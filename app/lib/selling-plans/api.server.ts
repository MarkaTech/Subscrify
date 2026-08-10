/**
 * Selling plan group operations against the Shopify Admin API.
 * All calls are made with a shop-scoped admin client obtained from
 * authenticate.admin(request) — invariant #2 (shop-scoped) holds because the
 * client can only ever act on the authenticated shop.
 */

import {
  toSellingPlanGroupCreateInput,
  toSellingPlanGroupUpdateInput,
  type ProgramConfig,
} from "./program";

/**
 * App-defined marker so Marka Subscrify lists only its own selling plan groups.
 *
 * DO NOT RENAME this value. It is stamped as `appId` on every group the app
 * creates in the merchant's store, and the list/get calls below filter on an
 * exact match. Change it and every program a merchant already created stops
 * being visible in the app — the groups are still live on their products and
 * still selling, they just vanish from this UI, and the merchant can silently
 * create a duplicate on top. The display name changed to "Marka Subscrify" on
 * 2026-08-10; this identifier stayed put deliberately.
 */
export const SUBSCRIFY_APP_ID = "subscrify";

// Minimal admin-client shape (from authenticate.admin) we depend on.
export interface AdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<any> }>;
}

export interface ProgramSummary {
  id: string;
  name: string;
  merchantCode: string;
  optionLabel: string;
  planCount: number;
  productCount: number;
  summary: string | null;
}

export interface ProgramDetail extends ProgramSummary {
  plans: Array<{
    id: string;
    name: string;
    optionLabel: string;
    billing: { interval: string; intervalCount: number } | null;
    delivery: { interval: string; intervalCount: number } | null;
    pricingSummary: string;
  }>;
  productIds: string[];
  productTitles: string[];
}

const GROUP_FIELDS = `#graphql
  fragment GroupFields on SellingPlanGroup {
    id
    name
    merchantCode
    appId
    options
    summary
    productsCount { count }
    sellingPlans(first: 25) {
      edges {
        node {
          id
          name
          options
          billingPolicy {
            ... on SellingPlanRecurringBillingPolicy { interval intervalCount }
          }
          deliveryPolicy {
            ... on SellingPlanRecurringDeliveryPolicy { interval intervalCount }
          }
          pricingPolicies {
            ... on SellingPlanFixedPricingPolicy {
              adjustmentType
              adjustmentValue {
                ... on SellingPlanPricingPolicyPercentageValue { percentage }
                ... on MoneyV2 { amount currencyCode }
              }
            }
          }
        }
      }
    }
  }
`;

function throwOnUserErrors(payload: any, mutation: string) {
  const errors = payload?.data?.[mutation]?.userErrors;
  if (errors?.length) {
    throw new SellingPlanApiError(
      errors.map((e: any) => e.message).join("; "),
      errors,
    );
  }
}

export class SellingPlanApiError extends Error {
  userErrors: Array<{ field?: string[]; message: string }>;
  constructor(message: string, userErrors: Array<{ field?: string[]; message: string }>) {
    super(message);
    this.userErrors = userErrors;
  }
}

function pricingSummary(policies: any[]): string {
  const p = policies?.[0];
  if (!p) return "No discount";
  if (p.adjustmentValue?.percentage != null) return `${p.adjustmentValue.percentage}% off`;
  if (p.adjustmentValue?.amount != null) return `${p.adjustmentValue.amount} ${p.adjustmentValue.currencyCode} off`;
  return "Discounted";
}

function nodeToDetail(node: any): ProgramDetail {
  return {
    id: node.id,
    name: node.name,
    merchantCode: node.merchantCode,
    optionLabel: node.options?.[0] ?? "Deliver every",
    planCount: node.sellingPlans?.edges?.length ?? 0,
    productCount: node.productsCount?.count ?? 0,
    summary: node.summary ?? null,
    plans: (node.sellingPlans?.edges ?? []).map(({ node: p }: any) => ({
      id: p.id,
      name: p.name,
      optionLabel: p.options?.[0] ?? "",
      billing: p.billingPolicy?.interval
        ? { interval: p.billingPolicy.interval, intervalCount: p.billingPolicy.intervalCount }
        : null,
      delivery: p.deliveryPolicy?.interval
        ? { interval: p.deliveryPolicy.interval, intervalCount: p.deliveryPolicy.intervalCount }
        : null,
      pricingSummary: pricingSummary(p.pricingPolicies ?? []),
    })),
    productIds: [],
    productTitles: [],
  };
}

export async function listPrograms(admin: AdminClient): Promise<ProgramSummary[]> {
  const response = await admin.graphql(
    `#graphql
    ${GROUP_FIELDS}
    query subscrifyListGroups {
      sellingPlanGroups(first: 50) {
        edges { node { ...GroupFields } }
      }
    }`,
  );
  const json = await response.json();
  const edges = json?.data?.sellingPlanGroups?.edges ?? [];
  return edges
    .map(({ node }: any) => node)
    .filter((node: any) => node.appId === SUBSCRIFY_APP_ID)
    .map((node: any) => {
      const d = nodeToDetail(node);
      return {
        id: d.id,
        name: d.name,
        merchantCode: d.merchantCode,
        optionLabel: d.optionLabel,
        planCount: d.planCount,
        productCount: d.productCount,
        summary: d.summary,
      };
    });
}

export async function getProgram(admin: AdminClient, id: string): Promise<ProgramDetail | null> {
  const response = await admin.graphql(
    `#graphql
    ${GROUP_FIELDS}
    query subscrifyGetGroup($id: ID!) {
      sellingPlanGroup(id: $id) {
        ...GroupFields
        products(first: 50) { edges { node { id title } } }
      }
    }`,
    { variables: { id } },
  );
  const json = await response.json();
  const node = json?.data?.sellingPlanGroup;
  if (!node || node.appId !== SUBSCRIFY_APP_ID) return null;
  const detail = nodeToDetail(node);
  detail.productIds = (node.products?.edges ?? []).map(({ node: p }: any) => p.id);
  detail.productTitles = (node.products?.edges ?? []).map(({ node: p }: any) => p.title);
  return detail;
}

export async function createProgram(
  admin: AdminClient,
  config: ProgramConfig,
  productIds: string[],
): Promise<string> {
  const input = { ...toSellingPlanGroupCreateInput(config), appId: SUBSCRIFY_APP_ID };
  const response = await admin.graphql(
    `#graphql
    mutation subscrifyCreateGroup($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput) {
      sellingPlanGroupCreate(input: $input, resources: $resources) {
        sellingPlanGroup { id }
        userErrors { field message }
      }
    }`,
    { variables: { input, resources: { productIds, productVariantIds: [] } } },
  );
  const json = await response.json();
  throwOnUserErrors(json, "sellingPlanGroupCreate");
  return json.data.sellingPlanGroupCreate.sellingPlanGroup.id;
}

export async function updateProgram(
  admin: AdminClient,
  groupId: string,
  config: ProgramConfig,
  planIds: Array<string | null>,
  currentPlanIds: string[],
): Promise<void> {
  const input = toSellingPlanGroupUpdateInput(config, planIds, currentPlanIds);
  const response = await admin.graphql(
    `#graphql
    mutation subscrifyUpdateGroup($id: ID!, $input: SellingPlanGroupInput!) {
      sellingPlanGroupUpdate(id: $id, input: $input) {
        sellingPlanGroup { id }
        userErrors { field message }
      }
    }`,
    { variables: { id: groupId, input } },
  );
  throwOnUserErrors(await response.json(), "sellingPlanGroupUpdate");
}

export async function setProgramProducts(
  admin: AdminClient,
  groupId: string,
  desiredProductIds: string[],
  currentProductIds: string[],
): Promise<void> {
  const desired = new Set(desiredProductIds);
  const current = new Set(currentProductIds);
  const toAdd = desiredProductIds.filter((id) => !current.has(id));
  const toRemove = currentProductIds.filter((id) => !desired.has(id));

  if (toAdd.length) {
    const response = await admin.graphql(
      `#graphql
      mutation subscrifyAddProducts($id: ID!, $productIds: [ID!]!) {
        sellingPlanGroupAddProducts(id: $id, productIds: $productIds) {
          sellingPlanGroup { id }
          userErrors { field message }
        }
      }`,
      { variables: { id: groupId, productIds: toAdd } },
    );
    throwOnUserErrors(await response.json(), "sellingPlanGroupAddProducts");
  }
  if (toRemove.length) {
    const response = await admin.graphql(
      `#graphql
      mutation subscrifyRemoveProducts($id: ID!, $productIds: [ID!]!) {
        sellingPlanGroupRemoveProducts(id: $id, productIds: $productIds) {
          removedProductIds
          userErrors { field message }
        }
      }`,
      { variables: { id: groupId, productIds: toRemove } },
    );
    throwOnUserErrors(await response.json(), "sellingPlanGroupRemoveProducts");
  }
}

export async function deleteProgram(admin: AdminClient, groupId: string): Promise<void> {
  const response = await admin.graphql(
    `#graphql
    mutation subscrifyDeleteGroup($id: ID!) {
      sellingPlanGroupDelete(id: $id) {
        deletedSellingPlanGroupId
        userErrors { field message }
      }
    }`,
    { variables: { id: groupId } },
  );
  throwOnUserErrors(await response.json(), "sellingPlanGroupDelete");
}
