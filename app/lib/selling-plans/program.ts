/**
 * Subscription program domain model + mapping to Shopify selling plan groups.
 *
 * A "program" is what merchants configure in Subscrify's admin (e.g.
 * "Subscribe & Save — deliver every 1/2/4 weeks at 10% off"). The selling
 * plan group saved to Shopify is the source of truth; this module is the
 * single place that translates program config → Shopify GraphQL input.
 *
 * Pure functions only — no network, no framework — so every rule here is
 * unit-testable in isolation.
 */

export type DeliveryInterval = "DAY" | "WEEK" | "MONTH" | "YEAR";

export interface PlanConfig {
  /** e.g. "Deliver every 2 weeks" — shown to buyers */
  name: string;
  /** e.g. "2 Weeks" — the option value shown in the storefront selector */
  optionLabel: string;
  deliveryInterval: DeliveryInterval;
  deliveryIntervalCount: number;
  /**
   * How many deliveries each charge pays for.
   * 1 = pay per delivery (classic subscribe & save).
   * >1 = prepaid: billing interval = delivery interval × this count
   *     (e.g. deliver monthly, deliveriesPerCharge 3 → billed every 3 months).
   */
  deliveriesPerCharge: number;
  discount: { type: "NONE" } | { type: "PERCENTAGE"; value: number } | { type: "AMOUNT"; value: number };
}

export interface ProgramConfig {
  /** Group name buyers see, e.g. "Subscribe & Save" */
  name: string;
  /** Merchant-facing code; defaults derived from name */
  merchantCode?: string;
  /** Label for the option dropdown, e.g. "Deliver every" */
  optionLabel: string;
  plans: PlanConfig[];
}

export interface ValidationIssue {
  field: string;
  message: string;
}

const MAX_PLANS = 10;

export function validateProgram(config: ProgramConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!config.name.trim()) {
    issues.push({ field: "name", message: "Program name is required" });
  }
  if (!config.optionLabel.trim()) {
    issues.push({ field: "optionLabel", message: "Option label is required" });
  }
  if (config.plans.length === 0) {
    issues.push({ field: "plans", message: "Add at least one plan" });
  }
  if (config.plans.length > MAX_PLANS) {
    issues.push({ field: "plans", message: `At most ${MAX_PLANS} plans per program` });
  }

  config.plans.forEach((plan, i) => {
    const at = (f: string) => `plans[${i}].${f}`;
    if (!plan.name.trim()) {
      issues.push({ field: at("name"), message: "Plan name is required" });
    }
    if (!plan.optionLabel.trim()) {
      issues.push({ field: at("optionLabel"), message: "Plan option label is required" });
    }
    if (!Number.isInteger(plan.deliveryIntervalCount) || plan.deliveryIntervalCount < 1) {
      issues.push({ field: at("deliveryIntervalCount"), message: "Delivery frequency must be a whole number of 1 or more" });
    }
    if (!Number.isInteger(plan.deliveriesPerCharge) || plan.deliveriesPerCharge < 1) {
      issues.push({ field: at("deliveriesPerCharge"), message: "Deliveries per charge must be a whole number of 1 or more" });
    }
    if (plan.discount.type === "PERCENTAGE") {
      if (!(plan.discount.value > 0) || plan.discount.value > 100) {
        issues.push({ field: at("discount"), message: "Percentage discount must be between 0 and 100" });
      }
    }
    if (plan.discount.type === "AMOUNT" && !(plan.discount.value > 0)) {
      issues.push({ field: at("discount"), message: "Amount discount must be greater than 0" });
    }
  });

  const labels = new Set<string>();
  for (const plan of config.plans) {
    const key = plan.optionLabel.trim().toLowerCase();
    if (labels.has(key)) {
      issues.push({ field: "plans", message: `Duplicate plan option "${plan.optionLabel}" — each plan needs a distinct label` });
      break;
    }
    labels.add(key);
  }

  return issues;
}

/** Billing interval = delivery interval × deliveriesPerCharge, normalized. */
export function billingPolicyFor(plan: PlanConfig): { interval: DeliveryInterval; intervalCount: number } {
  return {
    interval: plan.deliveryInterval,
    intervalCount: plan.deliveryIntervalCount * plan.deliveriesPerCharge,
  };
}

function pricingPoliciesFor(plan: PlanConfig): unknown[] {
  switch (plan.discount.type) {
    case "NONE":
      return [];
    case "PERCENTAGE":
      return [
        {
          fixed: {
            adjustmentType: "PERCENTAGE",
            adjustmentValue: { percentage: plan.discount.value },
          },
        },
      ];
    case "AMOUNT":
      return [
        {
          fixed: {
            adjustmentType: "FIXED_AMOUNT",
            adjustmentValue: { fixedValue: plan.discount.value },
          },
        },
      ];
  }
}

export function toMerchantCode(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 255) || "subscription-program"
  );
}

function toSellingPlanInput(plan: PlanConfig, position: number) {
  const billing = billingPolicyFor(plan);
  return {
    name: plan.name,
    options: [plan.optionLabel],
    position,
    category: "SUBSCRIPTION",
    billingPolicy: {
      recurring: {
        interval: billing.interval,
        intervalCount: billing.intervalCount,
      },
    },
    deliveryPolicy: {
      recurring: {
        interval: plan.deliveryInterval,
        intervalCount: plan.deliveryIntervalCount,
        intent: "FULFILLMENT_BEGIN",
        preAnchorBehavior: "ASAP",
      },
    },
    pricingPolicies: pricingPoliciesFor(plan),
  };
}

/** Input for sellingPlanGroupCreate. */
export function toSellingPlanGroupCreateInput(config: ProgramConfig) {
  return {
    name: config.name,
    merchantCode: config.merchantCode?.trim() || toMerchantCode(config.name),
    options: [config.optionLabel],
    position: 1,
    sellingPlansToCreate: config.plans.map((plan, i) => toSellingPlanInput(plan, i + 1)),
  };
}

/**
 * Input for sellingPlanGroupUpdate.
 * Existing plans (with ids) are updated in place; new plans are created;
 * plans no longer present are deleted. `existingPlanIds` is the ordered list
 * of Shopify SellingPlan GIDs currently in the group; each plan in config may
 * carry `existingId` to link it.
 */
export function toSellingPlanGroupUpdateInput(
  config: ProgramConfig,
  planIds: Array<string | null>,
  currentPlanIdsOnShopify: string[],
) {
  if (planIds.length !== config.plans.length) {
    throw new Error("planIds must align 1:1 with config.plans");
  }
  const keep = new Set(planIds.filter((id): id is string => Boolean(id)));
  const sellingPlansToDelete = currentPlanIdsOnShopify.filter((id) => !keep.has(id));

  const sellingPlansToUpdate = config.plans
    .map((plan, i) => ({ plan, id: planIds[i], position: i + 1 }))
    .filter((entry): entry is { plan: PlanConfig; id: string; position: number } => Boolean(entry.id))
    .map(({ plan, id, position }) => ({ id, ...toSellingPlanInput(plan, position) }));

  const sellingPlansToCreate = config.plans
    .map((plan, i) => ({ plan, id: planIds[i], position: i + 1 }))
    .filter((entry) => !entry.id)
    .map(({ plan, position }) => toSellingPlanInput(plan, position));

  return {
    name: config.name,
    merchantCode: config.merchantCode?.trim() || toMerchantCode(config.name),
    options: [config.optionLabel],
    sellingPlansToCreate,
    sellingPlansToUpdate,
    sellingPlansToDelete,
  };
}
