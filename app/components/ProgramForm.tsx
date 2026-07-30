import { useCallback, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { DeliveryInterval, PlanConfig, ProgramConfig } from "../lib/selling-plans/program";

export interface ProgramFormValue {
  config: ProgramConfig;
  /** Aligned with config.plans; null = new plan (no Shopify id yet). */
  planIds: Array<string | null>;
  productIds: string[];
  productTitles: string[];
}

export function emptyPlan(): PlanConfig {
  return {
    name: "Deliver every month",
    optionLabel: "1 Month",
    deliveryInterval: "MONTH",
    deliveryIntervalCount: 1,
    deliveriesPerCharge: 1,
    discount: { type: "PERCENTAGE", value: 10 },
  };
}

const INTERVAL_LABELS: Record<DeliveryInterval, string> = {
  DAY: "day(s)",
  WEEK: "week(s)",
  MONTH: "month(s)",
  YEAR: "year(s)",
};

function defaultPlanLabels(plan: PlanConfig): Pick<PlanConfig, "name" | "optionLabel"> {
  const unit = INTERVAL_LABELS[plan.deliveryInterval].replace("(s)", plan.deliveryIntervalCount > 1 ? "s" : "");
  return {
    name: `Deliver every ${plan.deliveryIntervalCount} ${unit}`,
    optionLabel: `${plan.deliveryIntervalCount} ${unit}`,
  };
}

export function ProgramForm({
  value,
  errors,
  submitting,
  submitLabel,
  onSubmit,
}: {
  value: ProgramFormValue;
  errors: string[];
  submitting: boolean;
  submitLabel: string;
  onSubmit: (value: ProgramFormValue) => void;
}) {
  const shopify = useAppBridge();
  const [config, setConfig] = useState<ProgramConfig>(value.config);
  const [planIds, setPlanIds] = useState<Array<string | null>>(value.planIds);
  const [productIds, setProductIds] = useState<string[]>(value.productIds);
  const [productTitles, setProductTitles] = useState<string[]>(value.productTitles);

  const setPlan = useCallback((index: number, patch: Partial<PlanConfig>) => {
    setConfig((prev) => {
      const plans = prev.plans.map((plan, i) => {
        if (i !== index) return plan;
        const next = { ...plan, ...patch };
        // Refresh derived labels when frequency changes and the merchant
        // hasn't customized them away from the previous derived values.
        if (patch.deliveryInterval || patch.deliveryIntervalCount) {
          const before = defaultPlanLabels(plan);
          const after = defaultPlanLabels(next);
          if (plan.name === before.name) next.name = after.name;
          if (plan.optionLabel === before.optionLabel) next.optionLabel = after.optionLabel;
        }
        return next;
      });
      return { ...prev, plans };
    });
  }, []);

  const addPlan = () => {
    setConfig((prev) => ({ ...prev, plans: [...prev.plans, emptyPlan()] }));
    setPlanIds((prev) => [...prev, null]);
  };

  const removePlan = (index: number) => {
    setConfig((prev) => ({ ...prev, plans: prev.plans.filter((_, i) => i !== index) }));
    setPlanIds((prev) => prev.filter((_, i) => i !== index));
  };

  const pickProducts = async () => {
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds: productIds.map((id) => ({ id })),
    });
    if (selection) {
      setProductIds(selection.map((p: any) => p.id));
      setProductTitles(selection.map((p: any) => p.title ?? p.id));
    }
  };

  return (
    <s-stack direction="block" gap="base">
      {errors.length > 0 && (
        <s-banner tone="critical" heading="Fix the following to save">
          <s-unordered-list>
            {errors.map((message) => (
              <s-list-item key={message}>{message}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}

      <s-section heading="Program">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Program name (buyers see this)"
            name="programName"
            value={config.name}
            onChange={(e: any) => setConfig((prev) => ({ ...prev, name: e.target.value }))}
          ></s-text-field>
          <s-text-field
            label="Option label (storefront dropdown label)"
            name="optionLabel"
            value={config.optionLabel}
            onChange={(e: any) => setConfig((prev) => ({ ...prev, optionLabel: e.target.value }))}
          ></s-text-field>
        </s-stack>
      </s-section>

      <s-section heading="Plans">
        <s-stack direction="block" gap="large">
          {config.plans.map((plan, index) => (
            <s-box key={index} padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" gap="base">
                  <s-text-field
                    label="Deliver every"
                    value={String(plan.deliveryIntervalCount)}
                    onChange={(e: any) =>
                      setPlan(index, { deliveryIntervalCount: Number(e.target.value) || 0 })
                    }
                  ></s-text-field>
                  <s-select
                    label="Unit"
                    value={plan.deliveryInterval}
                    onChange={(e: any) =>
                      setPlan(index, { deliveryInterval: e.target.value as DeliveryInterval })
                    }
                  >
                    <s-option value="DAY">Day(s)</s-option>
                    <s-option value="WEEK">Week(s)</s-option>
                    <s-option value="MONTH">Month(s)</s-option>
                    <s-option value="YEAR">Year(s)</s-option>
                  </s-select>
                  <s-select
                    label="Billing"
                    value={String(plan.deliveriesPerCharge)}
                    onChange={(e: any) =>
                      setPlan(index, { deliveriesPerCharge: Number(e.target.value) || 1 })
                    }
                  >
                    <s-option value="1">Pay per delivery</s-option>
                    <s-option value="2">Prepay 2 deliveries</s-option>
                    <s-option value="3">Prepay 3 deliveries</s-option>
                    <s-option value="6">Prepay 6 deliveries</s-option>
                    <s-option value="12">Prepay 12 deliveries</s-option>
                  </s-select>
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <s-select
                    label="Discount"
                    value={plan.discount.type}
                    onChange={(e: any) => {
                      const type = e.target.value as "NONE" | "PERCENTAGE" | "AMOUNT";
                      setPlan(index, {
                        discount:
                          type === "NONE"
                            ? { type }
                            : {
                                type,
                                value:
                                  plan.discount.type !== "NONE" ? plan.discount.value : 10,
                              },
                      });
                    }}
                  >
                    <s-option value="NONE">None</s-option>
                    <s-option value="PERCENTAGE">Percentage off</s-option>
                    <s-option value="AMOUNT">Amount off</s-option>
                  </s-select>
                  {plan.discount.type !== "NONE" && (
                    <s-text-field
                      label={plan.discount.type === "PERCENTAGE" ? "Percent off" : "Amount off"}
                      value={String(plan.discount.value)}
                      onChange={(e: any) =>
                        setPlan(index, {
                          discount: {
                            type: plan.discount.type as "PERCENTAGE" | "AMOUNT",
                            value: Number(e.target.value) || 0,
                          },
                        })
                      }
                    ></s-text-field>
                  )}
                </s-stack>
                <s-stack direction="inline" gap="base">
                  <s-text-field
                    label="Plan name (buyers see this)"
                    value={plan.name}
                    onChange={(e: any) => setPlan(index, { name: e.target.value })}
                  ></s-text-field>
                  <s-text-field
                    label="Option value"
                    value={plan.optionLabel}
                    onChange={(e: any) => setPlan(index, { optionLabel: e.target.value })}
                  ></s-text-field>
                </s-stack>
                {config.plans.length > 1 && (
                  <s-button tone="critical" variant="tertiary" onClick={() => removePlan(index)}>
                    Remove this plan
                  </s-button>
                )}
              </s-stack>
            </s-box>
          ))}
          <s-button variant="secondary" onClick={addPlan}>
            Add another plan
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Products">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            {productIds.length === 0
              ? "No products attached yet — buyers can only subscribe to attached products."
              : `${productIds.length} product(s): ${productTitles.slice(0, 5).join(", ")}${productTitles.length > 5 ? "…" : ""}`}
          </s-paragraph>
          <s-button variant="secondary" onClick={pickProducts}>
            Choose products
          </s-button>
        </s-stack>
      </s-section>

      <s-stack direction="inline" gap="base">
        <s-button
          variant="primary"
          {...(submitting ? { loading: true } : {})}
          onClick={() => onSubmit({ config, planIds, productIds, productTitles })}
        >
          {submitLabel}
        </s-button>
      </s-stack>
    </s-stack>
  );
}
