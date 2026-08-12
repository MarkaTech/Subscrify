import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * GDPR: erase a customer's personal data.
 *
 * Marka Subscrify stores no customer personal data of its own, so there is
 * nothing to erase. Name and email are read live from Shopify for display and
 * never written here; the billing-attempt log holds shop domain, contract
 * GIDs and charge status, which the shop-level `shop/redact` handler purges.
 *
 * DO NOT LOG THE PAYLOAD. It carries the customer's email and phone number,
 * and stdout is shipped to Log Analytics — logging it would leave a copy of
 * exactly the data the customer just asked to have erased. Only the shop and
 * the opaque customer id are recorded.
 *
 * If customer-scoped tables are ever added, delete that customer's rows here,
 * always filtered by the shop from the webhook (invariant #2).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const customerId = (payload as { customer?: { id?: unknown } } | null)?.customer?.id ?? null;
  console.log(
    `Received ${topic} webhook for ${shop} (customer ${customerId}) — no stored customer data to erase`,
  );
  return new Response();
};
