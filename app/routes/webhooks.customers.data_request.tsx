import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * GDPR: a customer requested their data from the merchant.
 * Subscrify stores no customer PII in its own database today (sessions are
 * shop-level). When subscription-related customer records are added, this
 * handler must collect and surface them to the merchant.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`, JSON.stringify(payload));
  return new Response();
};
