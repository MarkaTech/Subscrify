import { describe, expect, it } from "vitest";
import {
  billingPolicyFor,
  toMerchantCode,
  toSellingPlanGroupCreateInput,
  toSellingPlanGroupUpdateInput,
  validateProgram,
  type ProgramConfig,
} from "./program";

const weekly = {
  name: "Deliver every week",
  optionLabel: "1 Week",
  deliveryInterval: "WEEK" as const,
  deliveryIntervalCount: 1,
  deliveriesPerCharge: 1,
  discount: { type: "PERCENTAGE" as const, value: 10 },
};

const program: ProgramConfig = {
  name: "Subscribe & Save",
  optionLabel: "Deliver every",
  plans: [weekly],
};

describe("validateProgram", () => {
  it("accepts a valid program", () => {
    expect(validateProgram(program)).toEqual([]);
  });

  it("requires a name, option label, and at least one plan", () => {
    const issues = validateProgram({ name: " ", optionLabel: "", plans: [] });
    expect(issues.map((i) => i.field)).toEqual(
      expect.arrayContaining(["name", "optionLabel", "plans"]),
    );
  });

  it("rejects zero/negative/fractional frequencies", () => {
    for (const bad of [0, -1, 1.5]) {
      const issues = validateProgram({
        ...program,
        plans: [{ ...weekly, deliveryIntervalCount: bad }],
      });
      expect(issues.some((i) => i.field === "plans[0].deliveryIntervalCount")).toBe(true);
    }
  });

  it("rejects percentage discounts outside (0, 100]", () => {
    for (const bad of [0, -5, 101]) {
      const issues = validateProgram({
        ...program,
        plans: [{ ...weekly, discount: { type: "PERCENTAGE", value: bad } }],
      });
      expect(issues.some((i) => i.field === "plans[0].discount")).toBe(true);
    }
    expect(
      validateProgram({
        ...program,
        plans: [{ ...weekly, discount: { type: "PERCENTAGE", value: 100 } }],
      }),
    ).toEqual([]);
  });

  it("rejects duplicate plan option labels", () => {
    const issues = validateProgram({
      ...program,
      plans: [weekly, { ...weekly, name: "Also weekly" }],
    });
    expect(issues.some((i) => i.message.includes("Duplicate"))).toBe(true);
  });
});

describe("billingPolicyFor (prepaid math)", () => {
  it("pay-per-delivery bills at the delivery interval", () => {
    expect(billingPolicyFor(weekly)).toEqual({ interval: "WEEK", intervalCount: 1 });
  });

  it("prepaid multiplies the billing interval", () => {
    expect(
      billingPolicyFor({
        ...weekly,
        deliveryInterval: "MONTH",
        deliveryIntervalCount: 1,
        deliveriesPerCharge: 3,
      }),
    ).toEqual({ interval: "MONTH", intervalCount: 3 });
    expect(
      billingPolicyFor({ ...weekly, deliveryIntervalCount: 2, deliveriesPerCharge: 4 }),
    ).toEqual({ interval: "WEEK", intervalCount: 8 });
  });
});

describe("toSellingPlanGroupCreateInput", () => {
  it("builds the documented Shopify shape", () => {
    const input = toSellingPlanGroupCreateInput(program);
    expect(input).toMatchObject({
      name: "Subscribe & Save",
      merchantCode: "subscribe-save",
      options: ["Deliver every"],
      position: 1,
    });
    expect(input.sellingPlansToCreate).toHaveLength(1);
    expect(input.sellingPlansToCreate[0]).toMatchObject({
      name: "Deliver every week",
      options: ["1 Week"],
      position: 1,
      category: "SUBSCRIPTION",
      billingPolicy: { recurring: { interval: "WEEK", intervalCount: 1 } },
      deliveryPolicy: {
        recurring: {
          interval: "WEEK",
          intervalCount: 1,
          intent: "FULFILLMENT_BEGIN",
          preAnchorBehavior: "ASAP",
        },
      },
      pricingPolicies: [
        {
          fixed: {
            adjustmentType: "PERCENTAGE",
            adjustmentValue: { percentage: 10 },
          },
        },
      ],
    });
  });

  it("omits pricing policies when there is no discount", () => {
    const input = toSellingPlanGroupCreateInput({
      ...program,
      plans: [{ ...weekly, discount: { type: "NONE" } }],
    });
    expect(input.sellingPlansToCreate[0].pricingPolicies).toEqual([]);
  });

  it("maps fixed-amount discounts", () => {
    const input = toSellingPlanGroupCreateInput({
      ...program,
      plans: [{ ...weekly, discount: { type: "AMOUNT", value: 5 } }],
    });
    expect(input.sellingPlansToCreate[0].pricingPolicies).toEqual([
      {
        fixed: {
          adjustmentType: "FIXED_AMOUNT",
          adjustmentValue: { fixedValue: 5 },
        },
      },
    ]);
  });
});

describe("toSellingPlanGroupUpdateInput", () => {
  const existingId = "gid://shopify/SellingPlan/1";
  const removedId = "gid://shopify/SellingPlan/2";

  it("splits plans into update, create, and delete buckets", () => {
    const twoPlans: ProgramConfig = {
      ...program,
      plans: [weekly, { ...weekly, name: "Monthly", optionLabel: "1 Month", deliveryInterval: "MONTH" }],
    };
    const input = toSellingPlanGroupUpdateInput(
      twoPlans,
      [existingId, null],
      [existingId, removedId],
    );
    expect(input.sellingPlansToUpdate).toHaveLength(1);
    expect(input.sellingPlansToUpdate[0]).toMatchObject({ id: existingId, position: 1 });
    expect(input.sellingPlansToCreate).toHaveLength(1);
    expect(input.sellingPlansToCreate[0]).toMatchObject({ options: ["1 Month"], position: 2 });
    expect(input.sellingPlansToDelete).toEqual([removedId]);
  });

  it("refuses misaligned plan id arrays", () => {
    expect(() => toSellingPlanGroupUpdateInput(program, [], [])).toThrow(/align/);
  });
});

describe("toMerchantCode", () => {
  it("slugifies names", () => {
    expect(toMerchantCode("Subscribe & Save!")).toBe("subscribe-save");
    expect(toMerchantCode("  ")).toBe("subscription-program");
  });
});
