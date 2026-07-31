import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * Shopify admin's "manage subscription" deep link for contracts owned by this
 * app lands on /subscriptions?id=<numeric contract id>&customer_id=...
 * (seen on order pages and customer pages). Route it to our contract detail.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const target =
    id && /^\d+$/.test(id) ? `/app/contracts/${id}` : "/app/contracts";
  // Preserve embedded-app params (shop, host, embedded…) for the target's auth.
  const params = new URLSearchParams(url.searchParams);
  params.delete("id");
  params.delete("customer_id");
  const qs = params.toString();
  return redirect(qs ? `${target}?${qs}` : target);
};
