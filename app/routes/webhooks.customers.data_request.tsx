import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * GDPR: a customer asked the merchant for the data held about them.
 *
 * Marka Subscrify stores no customer personal data of its own. Customer name
 * and email are read live from Shopify for display and never written to this
 * app's database; the only tables are Shopify's session store (merchant staff)
 * and the billing-attempt log (shop domain, contract GIDs, charge status).
 * There is therefore nothing to collect and hand back — acknowledging the
 * request is the complete and correct response.
 *
 * DO NOT LOG THE PAYLOAD. Shopify's payload for this topic carries the
 * customer's email and phone number. Writing it to stdout would put customer
 * PII into Log Analytics — quietly creating the very store of personal data
 * this app's privacy position says it doesn't keep, inside a *privacy*
 * handler. Only the shop and the opaque customer id are recorded, which is
 * enough to evidence that the request was received and handled.
 *
 * If customer-scoped tables are ever added, collect that customer's rows here
 * and surface them to the merchant — still without logging the payload.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const customerId = (payload as { customer?: { id?: unknown } } | null)?.customer?.id ?? null;
  console.log(
    `Received ${topic} webhook for ${shop} (customer ${customerId}) — no stored customer data to return`,
  );
  return new Response();
};
