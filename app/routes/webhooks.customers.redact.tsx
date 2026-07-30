import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * GDPR: erase a customer's personal data.
 * Subscrify stores no customer PII in its own database today. When
 * subscription/customer tables are added, delete that customer's rows here —
 * always scoped to the shop from the webhook.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`, JSON.stringify(payload));
  return new Response();
};
