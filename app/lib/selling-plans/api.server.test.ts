import { describe, expect, it } from "vitest";
import {
  SUBSCRIFY_APP_ID,
  SellingPlanApiError,
  deleteProgram,
  updateProgram,
  type AdminClient,
} from "./api.server";
import type { ProgramConfig } from "./program";

/**
 * Fake AdminClient: an ordered queue of canned GraphQL responses. Each call
 * to .graphql() consumes the next one, so a test that expects N round trips
 * seeds N responses and asserts calls.length afterward.
 */
function fakeAdmin(responses: any[]): AdminClient & { calls: string[] } {
  const queue = [...responses];
  const calls: string[] = [];
  return {
    calls,
    async graphql(query: string) {
      calls.push(query);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("fakeAdmin: no more canned responses queued");
      }
      return { json: async () => next };
    },
  };
}

const config: ProgramConfig = {
  name: "Monthly",
  merchantCode: "monthly",
  optionLabel: "Deliver every",
  plans: [
    {
      name: "Monthly",
      optionLabel: "1 month",
      deliveryInterval: "MONTH",
      deliveryIntervalCount: 1,
      deliveriesPerCharge: 1,
      discount: { type: "NONE" },
    },
  ],
};

describe("throwOnUserErrors (via updateProgram) — top-level GraphQL errors", () => {
  it("throws when the response has top-level errors and null data, instead of silently returning", async () => {
    // Ownership check succeeds, but the mutation itself comes back with a
    // top-level GraphQL error (e.g. throttled) and data: null — before the
    // fix, throwOnUserErrors read payload.data[mutation].userErrors, found
    // undefined, and returned normally: updateProgram would resolve as if
    // the change saved when Shopify never applied it.
    const admin = fakeAdmin([
      { data: { sellingPlanGroup: { id: "gid://shopify/SellingPlanGroup/1", appId: SUBSCRIFY_APP_ID } } },
      { data: null, errors: [{ message: "Throttled" }] },
    ]);

    await expect(
      updateProgram(admin, "gid://shopify/SellingPlanGroup/1", config, [null], []),
    ).rejects.toThrow(SellingPlanApiError);
  });

  it("still throws SellingPlanApiError for a normal mutation-level userError", async () => {
    const admin = fakeAdmin([
      { data: { sellingPlanGroup: { id: "gid://shopify/SellingPlanGroup/1", appId: SUBSCRIFY_APP_ID } } },
      {
        data: {
          sellingPlanGroupUpdate: {
            sellingPlanGroup: null,
            userErrors: [{ field: ["name"], message: "Name can't be blank" }],
          },
        },
      },
    ]);

    await expect(
      updateProgram(admin, "gid://shopify/SellingPlanGroup/1", config, [null], []),
    ).rejects.toThrow("Name can't be blank");
  });

  it("succeeds and makes both round trips (ownership check + mutation) on a clean response", async () => {
    const admin = fakeAdmin([
      { data: { sellingPlanGroup: { id: "gid://shopify/SellingPlanGroup/1", appId: SUBSCRIFY_APP_ID } } },
      { data: { sellingPlanGroupUpdate: { sellingPlanGroup: { id: "gid://shopify/SellingPlanGroup/1" }, userErrors: [] } } },
    ]);

    await expect(
      updateProgram(admin, "gid://shopify/SellingPlanGroup/1", config, [null], []),
    ).resolves.toBeUndefined();
    expect(admin.calls).toHaveLength(2);
  });
});

describe("assertOwnedByApp (via updateProgram / deleteProgram) — ownership re-check on the write path", () => {
  it("updateProgram refuses to mutate a group this app didn't create, without attempting the mutation", async () => {
    const admin = fakeAdmin([
      // Ownership check: appId belongs to some other app/native subscriptions.
      { data: { sellingPlanGroup: { id: "gid://shopify/SellingPlanGroup/999", appId: "some-other-app" } } },
    ]);

    await expect(
      updateProgram(admin, "gid://shopify/SellingPlanGroup/999", config, [null], []),
    ).rejects.toThrow(/not owned by Marka Subscrify/);
    // Only the ownership-check round trip happened — no mutation was sent.
    expect(admin.calls).toHaveLength(1);
  });

  it("deleteProgram refuses to delete a group this app didn't create", async () => {
    const admin = fakeAdmin([
      { data: { sellingPlanGroup: { id: "gid://shopify/SellingPlanGroup/999", appId: null } } },
    ]);

    await expect(deleteProgram(admin, "gid://shopify/SellingPlanGroup/999")).rejects.toThrow(
      /not owned by Marka Subscrify/,
    );
    expect(admin.calls).toHaveLength(1);
  });

  it("updateProgram refuses when the group id doesn't resolve to anything (deleted/wrong shop)", async () => {
    const admin = fakeAdmin([{ data: { sellingPlanGroup: null } }]);

    await expect(
      updateProgram(admin, "gid://shopify/SellingPlanGroup/404", config, [], []),
    ).rejects.toThrow(SellingPlanApiError);
  });

  it("deleteProgram proceeds when the group is Subscrify-owned", async () => {
    const admin = fakeAdmin([
      { data: { sellingPlanGroup: { id: "gid://shopify/SellingPlanGroup/1", appId: SUBSCRIFY_APP_ID } } },
      { data: { sellingPlanGroupDelete: { deletedSellingPlanGroupId: "gid://shopify/SellingPlanGroup/1", userErrors: [] } } },
    ]);

    await expect(deleteProgram(admin, "gid://shopify/SellingPlanGroup/1")).resolves.toBeUndefined();
    expect(admin.calls).toHaveLength(2);
  });
});
