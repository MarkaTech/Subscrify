import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const meta: MetaFunction = () => [
  { title: "Marka Subscrify — Subscriptions for Shopify" },
  {
    name: "description",
    content:
      "Sell subscriptions on Shopify. Set up a subscribe & save program, attach it to products, and let renewals bill automatically with retries when a payment fails.",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // Shopify appends ?shop= when a merchant arrives from the admin or the App
  // Store — send them straight into the embedded app rather than showing this
  // marketing page.
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Turn one-time buyers into subscribers</h1>
        <p className={styles.text}>
          Marka Subscrify adds recurring orders to your Shopify store — set the
          delivery schedule, offer a subscriber discount, and let every renewal
          bill itself.
        </p>

        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="my-shop-domain.myshopify.com"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                required
              />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Install app
            </button>
          </Form>
        )}

        <ul className={styles.list}>
          <li>
            <strong>Set up a plan in minutes</strong> Choose how often an order
            repeats and what subscribers pay, then attach it to any product.
            The subscription option appears on those product pages
            automatically.
          </li>
          <li>
            <strong>Renewals bill themselves</strong> Every contract charges on
            its own schedule through Shopify&rsquo;s billing system, so payment
            details never leave Shopify and you never touch a card number.
          </li>
          <li>
            <strong>Failed payments retry on their own</strong> A declined
            charge is retried after 3, 5, and 7 days before it&rsquo;s marked
            failed — recovering revenue that would otherwise churn silently.
          </li>
          <li>
            <strong>Never charges twice</strong> Each billing cycle is locked
            to a single charge by three independent safeguards, so a retry,
            a duplicate webhook, or a restarted job can&rsquo;t double-bill a
            customer.
          </li>
          <li>
            <strong>See every subscription in one place</strong> Browse active
            contracts with the customer, items, status, and next billing date,
            and open any one to review its full billing history.
          </li>
        </ul>

        <p className={styles.footnote}>
          Built by MARKA MODERN RETAIL PRIVATE LIMITED.{" "}
          <a className={styles.footlink} href="/privacy">
            Privacy
          </a>{" "}
          &middot;{" "}
          <a className={styles.footlink} href="/terms">
            Terms &amp; DPA
          </a>
        </p>
      </div>
    </div>
  );
}
