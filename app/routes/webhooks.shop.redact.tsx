import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * GDPR: erase all data for a shop (sent ~48h after uninstall).
 * Every Subscrify table is shop-scoped, so purging is a delete per table
 * keyed on the shop domain. Extend this as tables are added.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  await db.session.deleteMany({ where: { shop } });

  return new Response();
};
