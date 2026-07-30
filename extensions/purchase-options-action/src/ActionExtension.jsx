/**
 * Subscrify purchase options extension.
 *
 * Lets merchants create a subscription program directly from the product (or
 * variant) page's "Purchase options" card — App Store requirement 5.4.6.
 * Creates a selling plan group via the direct Admin API and attaches the
 * current product/variant. Editing richer programs happens in the embedded
 * app (Programs section); Shopify itself handles add/remove of products to
 * existing options natively.
 */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};

function intervalLabel(unit, count) {
  const word = { DAY: "day", WEEK: "week", MONTH: "month", YEAR: "year" }[unit];
  return `${count} ${word}${Number(count) > 1 ? "s" : ""}`;
}

function Extension() {
  const [name, setName] = useState("Subscribe & Save");
  const [intervalCount, setIntervalCount] = useState("1");
  const [intervalUnit, setIntervalUnit] = useState("MONTH");
  const [percentOff, setPercentOff] = useState("10");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const selectedId = shopify.data?.selected?.[0]?.id ?? null;
  const isVariant = Boolean(selectedId && selectedId.includes("ProductVariant"));

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const count = Math.max(1, Math.floor(Number(intervalCount) || 1));
      const percentage = Math.min(100, Math.max(0, Number(percentOff) || 0));
      const label = intervalLabel(intervalUnit, count);
      const input = {
        name: name.trim() || "Subscribe & Save",
        merchantCode:
          (name.trim() || "subscribe-and-save").toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        options: ["Deliver every"],
        position: 1,
        appId: "subscrify",
        sellingPlansToCreate: [
          {
            name: `Deliver every ${label}`,
            options: [label],
            position: 1,
            category: "SUBSCRIPTION",
            billingPolicy: { recurring: { interval: intervalUnit, intervalCount: count } },
            deliveryPolicy: {
              recurring: {
                interval: intervalUnit,
                intervalCount: count,
                intent: "FULFILLMENT_BEGIN",
                preAnchorBehavior: "ASAP",
              },
            },
            pricingPolicies: percentage
              ? [
                  {
                    fixed: {
                      adjustmentType: "PERCENTAGE",
                      adjustmentValue: { percentage },
                    },
                  },
                ]
              : [],
          },
        ],
      };
      const resources = isVariant
        ? { productIds: [], productVariantIds: [selectedId] }
        : { productIds: selectedId ? [selectedId] : [], productVariantIds: [] };

      const response = await fetch("shopify:admin/api/graphql.json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation subscrifyCreateFromProductPage($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput) {
            sellingPlanGroupCreate(input: $input, resources: $resources) {
              sellingPlanGroup { id }
              userErrors { field message }
            }
          }`,
          variables: { input, resources },
        }),
      });
      const { data, errors } = await response.json();
      const userErrors = data?.sellingPlanGroupCreate?.userErrors ?? [];
      if (errors?.length || userErrors.length) {
        setError(
          [...(errors ?? []).map((e) => e.message), ...userErrors.map((e) => e.message)].join("; "),
        );
        return;
      }
      shopify.close();
    } catch {
      setError("Could not create the subscription program. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <s-admin-action heading="Create subscription program">
      <s-stack gap="base">
        {error && <s-banner tone="critical">{error}</s-banner>}
        <s-text-field
          label="Program name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        ></s-text-field>
        <s-stack direction="inline" gap="base">
          <s-text-field
            label="Deliver every"
            value={intervalCount}
            onChange={(e) => setIntervalCount(e.target.value)}
          ></s-text-field>
          <s-select
            label="Unit"
            value={intervalUnit}
            onChange={(e) => setIntervalUnit(e.target.value)}
          >
            <s-option value="DAY">Day(s)</s-option>
            <s-option value="WEEK">Week(s)</s-option>
            <s-option value="MONTH">Month(s)</s-option>
            <s-option value="YEAR">Year(s)</s-option>
          </s-select>
          <s-text-field
            label="Percent off"
            value={percentOff}
            onChange={(e) => setPercentOff(e.target.value)}
          ></s-text-field>
        </s-stack>
        <s-paragraph>
          Fine-tune plans, prepaid options, and products any time in Subscrify →
          Programs.
        </s-paragraph>
      </s-stack>
      <s-button
        slot="primary-action"
        variant="primary"
        {...(saving ? { loading: true } : {})}
        onClick={handleSave}
      >
        Create program
      </s-button>
      <s-button slot="secondary-actions" onClick={() => shopify.close()}>
        Cancel
      </s-button>
    </s-admin-action>
  );
}
