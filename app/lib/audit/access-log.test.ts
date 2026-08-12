import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actorFromSessionToken,
  logPersonalDataAccess,
  type PersonalDataAccessEvent,
} from "./access-log.server";

/** Capture the AUDIT lines this module writes, without them hitting the test output. */
function captureLogs(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

function parseOne(lines: string[]) {
  expect(lines).toHaveLength(1);
  expect(lines[0].startsWith("AUDIT ")).toBe(true);
  return JSON.parse(lines[0].slice("AUDIT ".length));
}

const baseEvent: PersonalDataAccessEvent = {
  shop: "example.myshopify.com",
  actorUserId: "1234567890",
  resource: "contract_detail",
  contractGid: "gid://shopify/SubscriptionContract/19323781338",
  recordCount: 1,
  fields: ["name", "email"],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logPersonalDataAccess", () => {
  it("emits one parseable AUDIT line carrying who/what/where", () => {
    const parsed = parseOne(captureLogs(() => logPersonalDataAccess(baseEvent)));

    expect(parsed.event).toBe("personal_data_access");
    expect(parsed.shop).toBe("example.myshopify.com");
    expect(parsed.actorUserId).toBe("1234567890");
    expect(parsed.resource).toBe("contract_detail");
    expect(parsed.contractGid).toBe(
      "gid://shopify/SubscriptionContract/19323781338",
    );
    expect(parsed.recordCount).toBe(1);
    expect(parsed.fields).toEqual(["name", "email"]);
    // Timestamped, and parseable as a real date — a trail without a clock is useless.
    expect(Number.isNaN(Date.parse(parsed.at))).toBe(false);
  });

  /**
   * The point of the whole design: the log records WHICH protected fields were
   * shown, never their values. If this ever fails, the audit log has quietly
   * become a second copy of the customer PII the app is supposed not to store.
   */
  it("never emits the personal data itself, only the field names", () => {
    const lines = captureLogs(() =>
      logPersonalDataAccess({
        ...baseEvent,
        // Deliberately shaped like a caller that got sloppy: these values must
        // not reach the log by any path, including via extra properties.
        ...({
          customerName: "Priya Sharma",
          customerEmail: "priya@example.com",
        } as unknown as PersonalDataAccessEvent),
      }),
    );

    const line = lines.join("\n");
    expect(line).not.toContain("Priya");
    expect(line).not.toContain("Sharma");
    expect(line).not.toContain("priya@example.com");
    expect(line).not.toContain("@");
  });

  it("records a null actor as null rather than dropping the field", () => {
    // "We don't know who" must be visible in the trail, not indistinguishable
    // from "this was never logged".
    const parsed = parseOne(
      captureLogs(() => logPersonalDataAccess({ ...baseEvent, actorUserId: null })),
    );
    expect(parsed).toHaveProperty("actorUserId");
    expect(parsed.actorUserId).toBeNull();
  });

  it("normalises a missing contractGid to null for list views", () => {
    const parsed = parseOne(
      captureLogs(() =>
        logPersonalDataAccess({
          shop: "example.myshopify.com",
          actorUserId: "42",
          resource: "contract_list",
          recordCount: 7,
          fields: ["name"],
        }),
      ),
    );
    expect(parsed.contractGid).toBeNull();
    expect(parsed.recordCount).toBe(7);
  });

  /**
   * An audit write must never be able to break the page a merchant is loading.
   * A dropped log line is bad; a subscriptions page that 500s because logging
   * failed is worse, and pushes people toward turning the logging off.
   */
  it("swallows a failing console rather than throwing into the loader", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout is gone");
    });
    try {
      expect(() => logPersonalDataAccess(baseEvent)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("survives an unserialisable event instead of propagating the error", () => {
    const circular: any = { ...baseEvent };
    circular.fields = circular; // JSON.stringify will throw on this
    expect(() => logPersonalDataAccess(circular)).not.toThrow();
  });
});

describe("actorFromSessionToken", () => {
  it("reads the staff user id from the session token's sub claim", () => {
    expect(actorFromSessionToken({ sub: "112233445566" })).toBe("112233445566");
  });

  it("stringifies a numeric sub", () => {
    expect(actorFromSessionToken({ sub: 112233445566 })).toBe("112233445566");
  });

  it("returns null — never the string \"undefined\" — when sub is unusable", () => {
    // Anything other than a usable id must land as null, so the trail says
    // "unknown actor" rather than recording a fake one.
    expect(actorFromSessionToken(undefined)).toBeNull();
    expect(actorFromSessionToken(null)).toBeNull();
    expect(actorFromSessionToken({})).toBeNull();
    expect(actorFromSessionToken({ sub: "" })).toBeNull();
    expect(actorFromSessionToken({ sub: null })).toBeNull();
    expect(actorFromSessionToken({ sub: { id: 1 } })).toBeNull();
    expect(actorFromSessionToken("not-a-token")).toBeNull();
  });
});
