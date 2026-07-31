import { describe, expect, it } from "vitest";
import {
  billingAttemptIdempotencyKey,
  billingRetryIdempotencyKey,
} from "./idempotency.server";

const ref = {
  shop: "subscrify-test.myshopify.com",
  subscriptionContractGid: "gid://shopify/SubscriptionContract/123",
  billingCycleIndex: 7,
};

describe("billingAttemptIdempotencyKey", () => {
  it("is deterministic — same cycle always yields the same key", () => {
    expect(billingAttemptIdempotencyKey(ref)).toBe(
      billingAttemptIdempotencyKey({ ...ref }),
    );
  });

  it("derives only from shop + contract + cycle", () => {
    expect(billingAttemptIdempotencyKey(ref)).toBe(
      "subscrify-v1-subscrify-test.myshopify.com-123-7",
    );
  });

  it("changes when the billing cycle changes", () => {
    expect(billingAttemptIdempotencyKey({ ...ref, billingCycleIndex: 8 })).not.toBe(
      billingAttemptIdempotencyKey(ref),
    );
  });

  it("changes when the shop changes (tenant isolation)", () => {
    expect(
      billingAttemptIdempotencyKey({ ...ref, shop: "other-shop.myshopify.com" }),
    ).not.toBe(billingAttemptIdempotencyKey(ref));
  });

  it("normalizes shop casing/whitespace so retries can't diverge", () => {
    expect(
      billingAttemptIdempotencyKey({ ...ref, shop: " Subscrify-Test.myshopify.com " }),
    ).toBe(billingAttemptIdempotencyKey(ref));
  });

  it("rejects non-contract GIDs", () => {
    expect(() =>
      billingAttemptIdempotencyKey({
        ...ref,
        subscriptionContractGid: "gid://shopify/Order/123",
      }),
    ).toThrow(/SubscriptionContract/);
  });

  it("rejects invalid shops and cycle indexes", () => {
    expect(() =>
      billingAttemptIdempotencyKey({ ...ref, shop: "not-a-shop.example.com" }),
    ).toThrow(/invalid shop/);
    expect(() =>
      billingAttemptIdempotencyKey({ ...ref, billingCycleIndex: 0 }),
    ).toThrow(/cycle index/);
    expect(() =>
      billingAttemptIdempotencyKey({ ...ref, billingCycleIndex: 1.5 }),
    ).toThrow(/cycle index/);
  });
});

describe("billingRetryIdempotencyKey", () => {
  it("differs from the original attempt key", () => {
    expect(billingRetryIdempotencyKey(ref, 2)).not.toBe(
      billingAttemptIdempotencyKey(ref),
    );
  });

  it("is deterministic per attempt number", () => {
    expect(billingRetryIdempotencyKey(ref, 2)).toBe(
      billingRetryIdempotencyKey({ ...ref }, 2),
    );
  });

  it("differs between attempt numbers for the same cycle", () => {
    expect(billingRetryIdempotencyKey(ref, 2)).not.toBe(
      billingRetryIdempotencyKey(ref, 3),
    );
  });

  it("is built on top of the base key", () => {
    expect(billingRetryIdempotencyKey(ref, 2)).toBe(
      "subscrify-v1-subscrify-test.myshopify.com-123-7-retry2",
    );
  });

  it("rejects attempt number < 2", () => {
    expect(() => billingRetryIdempotencyKey(ref, 1)).toThrow(/attempt number/);
    expect(() => billingRetryIdempotencyKey(ref, 0)).toThrow(/attempt number/);
    expect(() => billingRetryIdempotencyKey(ref, 1.5)).toThrow(/attempt number/);
  });

  it("still validates shop/contract/cycle the same way as the base key", () => {
    expect(() =>
      billingRetryIdempotencyKey({ ...ref, shop: "not-a-shop.example.com" }, 2),
    ).toThrow(/invalid shop/);
  });
});
