import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * GDPR: erase all data for a shop (sent ~48h after uninstall).
 *
 * Every Subscrify table is shop-scoped (invariant #2), so purging is one
 * delete per table keyed on the shop domain.
 *
 * KEEP THIS IN SYNC WITH prisma/schema.prisma. Every model with a `shop`
 * column must be deleted here. This handler silently fell out of date once
 * already: Phase 4 added BillingCycleAttempt and this file kept deleting only
 * sessions, so a shop that asked to be erased kept its billing history
 * indefinitely. Those rows carry the shop domain and subscription contract
 * GIDs, and a contract GID resolves back to an individual customer in
 * Shopify — so leaving them behind is a real erasure failure, not a
 * technicality. If you add a model, add it below.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // Billing history first: it is the data with the longest retention and the
  // clearest link back to individuals. Sessions last, since losing the
  // session mid-way would not prevent a redelivery from finishing the job
  // (this webhook is authenticated by HMAC, not by a stored session).
  const billingAttempts = await db.billingCycleAttempt.deleteMany({ where: { shop } });
  const sessions = await db.session.deleteMany({ where: { shop } });

  console.log(
    `shop/redact for ${shop}: deleted ${billingAttempts.count} billing attempt(s), ${sessions.count} session(s)`,
  );

  return new Response();
};
