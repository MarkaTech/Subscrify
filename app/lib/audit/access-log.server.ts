/**
 * Audit trail for access to customers' personal data.
 *
 * Answers the question a data-protection reviewer actually asks: "who looked
 * at this customer's details, and when?" Shopify's protected-customer-data
 * review asks it directly ("Do you log access to personal data?").
 *
 * WHAT IS AND ISN'T RECORDED
 *
 * Recorded: when it happened, which shop, which staff member, which
 * subscription contract, and which protected fields were displayed.
 *
 * NOT recorded: the personal data itself. No names, no email addresses, ever.
 * An audit log that copies the data it is auditing just creates a second,
 * less-guarded store of the same personal data — and this app's whole
 * position is that it doesn't store customer PII at all (it reads it live
 * from Shopify for display). Logging the field *names* proves what was
 * exposed without becoming a liability.
 *
 * WHERE IT GOES
 *
 * stdout, as one structured JSON line per event. Azure Container Apps ships
 * container stdout to the Log Analytics workspace declared in
 * infra/main.bicep, so these are queryable and retained there — no new
 * database table, and so no new retention obligation of its own.
 *
 * Query them with (KQL):
 *   ContainerAppConsoleLogs_CL
 *   | where Log_s startswith "AUDIT "
 *   | extend a = parse_json(substring(Log_s, 6))
 *   | where a.shop == "example.myshopify.com"
 *
 * Deliberately NOT awaited by callers and never throwing: an audit write must
 * not be able to break the page a merchant is trying to load. A dropped log
 * line is bad; a subscriptions page that 500s because logging failed is
 * worse, and would push people toward disabling the logging entirely.
 */

/** The protected fields this app can display. Mirrors the Partner Dashboard grants. */
export type ProtectedField = "name" | "email";

export interface PersonalDataAccessEvent {
  /** myshopify domain — invariant #2, every audit line is shop-scoped. */
  shop: string;
  /**
   * Staff member who viewed it, from the session token's `sub` claim (a
   * Shopify staff user id). Null when it can't be determined — recorded
   * honestly as null rather than omitted, so "we don't know who" is
   * visible in the trail instead of looking like it was never logged.
   */
  actorUserId: string | null;
  /** What was viewed: a list of contracts, or one contract's detail. */
  resource: "contract_list" | "contract_detail";
  /** Contract GID for contract_detail; null for a list view. */
  contractGid?: string | null;
  /** How many records were displayed — a bulk read looks different to a single one. */
  recordCount: number;
  /** Which protected fields were actually shown. */
  fields: ProtectedField[];
}

export function logPersonalDataAccess(event: PersonalDataAccessEvent): void {
  try {
    // eslint-disable-next-line no-console
    console.log(
      `AUDIT ${JSON.stringify({
        event: "personal_data_access",
        at: new Date().toISOString(),
        shop: event.shop,
        actorUserId: event.actorUserId,
        resource: event.resource,
        contractGid: event.contractGid ?? null,
        recordCount: event.recordCount,
        fields: event.fields,
      })}`,
    );
  } catch {
    // Never let auditing break a page load. See the module comment.
  }
}

/**
 * Pull the acting staff member out of a decoded session token.
 *
 * `sub` is the staff user id on Shopify's session-token JWT. It can be absent
 * for non-user contexts, so this normalises anything unusable to null rather
 * than stringifying `undefined` into the trail.
 */
export function actorFromSessionToken(sessionToken: unknown): string | null {
  const sub = (sessionToken as { sub?: unknown } | null | undefined)?.sub;
  if (typeof sub === "string" && sub.length > 0) return sub;
  if (typeof sub === "number") return String(sub);
  return null;
}
