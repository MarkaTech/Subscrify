import { describe, expect, it } from "vitest";
import { allowedActions, isActionAllowed } from "./lifecycle";
import { runLifecycleAction } from "./lifecycle.server";

/**
 * Minimal admin-client double. Records what was sent so the tests can assert
 * the right mutation went out, and returns whatever payload the test supplies.
 */
function fakeAdmin(payload: any, capture?: { doc?: string; variables?: any }) {
  return {
    graphql: async (doc: string, opts?: { variables?: any }) => {
      if (capture) {
        capture.doc = doc;
        capture.variables = opts?.variables;
      }
      return { json: async () => payload };
    },
  } as any;
}

describe("allowedActions", () => {
  it("lets an active contract be paused or cancelled, but not resumed", () => {
    expect(allowedActions("ACTIVE").sort()).toEqual(["cancel", "pause"]);
    expect(isActionAllowed("ACTIVE", "resume")).toBe(false);
  });

  it("lets a paused contract be resumed or cancelled, but not paused again", () => {
    expect(allowedActions("PAUSED").sort()).toEqual(["cancel", "resume"]);
    expect(isActionAllowed("PAUSED", "pause")).toBe(false);
  });

  it("allows nothing from CANCELLED — it is terminal in Shopify", () => {
    expect(allowedActions("CANCELLED")).toEqual([]);
    expect(isActionAllowed("CANCELLED", "resume")).toBe(false);
    expect(isActionAllowed("CANCELLED", "cancel")).toBe(false);
  });

  it("allows nothing for an unrecognised status rather than guessing", () => {
    // Shopify can add statuses; defaulting to "no actions" fails closed.
    expect(allowedActions("EXPIRED")).toEqual([]);
    expect(allowedActions("FAILED")).toEqual([]);
    expect(allowedActions("")).toEqual([]);
  });
});

describe("runLifecycleAction", () => {
  it("sends the pause mutation with the contract id and reports the new status", async () => {
    const capture: { doc?: string; variables?: any } = {};
    const admin = fakeAdmin(
      { data: { subscriptionContractPause: { contract: { id: "gid://x/1", status: "PAUSED" }, userErrors: [] } } },
      capture,
    );

    const result = await runLifecycleAction(admin, "gid://x/1", "pause");

    expect(result).toEqual({ ok: true, status: "PAUSED" });
    expect(capture.doc).toContain("subscriptionContractPause");
    expect(capture.variables).toEqual({ contractId: "gid://x/1" });
  });

  it("maps resume to subscriptionContractActivate", async () => {
    const capture: { doc?: string } = {};
    const admin = fakeAdmin(
      { data: { subscriptionContractActivate: { contract: { id: "g", status: "ACTIVE" }, userErrors: [] } } },
      capture,
    );

    const result = await runLifecycleAction(admin, "g", "resume");

    expect(result.ok).toBe(true);
    expect(result.status).toBe("ACTIVE");
    expect(capture.doc).toContain("subscriptionContractActivate");
  });

  it("surfaces userErrors as a merchant-readable failure", async () => {
    const admin = fakeAdmin({
      data: {
        subscriptionContractCancel: {
          contract: null,
          userErrors: [{ field: ["subscriptionContractId"], message: "Contract already cancelled" }],
        },
      },
    });

    const result = await runLifecycleAction(admin, "g", "cancel");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Contract already cancelled");
  });

  it("surfaces top-level GraphQL errors (bad scope, throttling)", async () => {
    const admin = fakeAdmin({ errors: [{ message: "Access denied" }] });

    const result = await runLifecycleAction(admin, "g", "pause");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Access denied");
  });

  it("treats a missing contract in the response as failure, not silent success", async () => {
    // No userErrors and no contract — we cannot evidence that anything happened,
    // so reporting success would tell the merchant a lie.
    const admin = fakeAdmin({ data: { subscriptionContractPause: { contract: null, userErrors: [] } } });

    const result = await runLifecycleAction(admin, "g", "pause");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("did not confirm");
  });

  it("returns a failure rather than throwing when the request itself blows up", async () => {
    const admin = {
      graphql: async () => {
        throw new Error("socket hang up");
      },
    } as any;

    const result = await runLifecycleAction(admin, "g", "cancel");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("socket hang up");
  });
});
