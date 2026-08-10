import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { listPrograms } from "../lib/selling-plans/api.server";
import { listContracts } from "../lib/contracts/api.server";

/**
 * Home / overview.
 *
 * Loads the two counts the setup checklist keys off. Both calls are wrapped
 * individually: this is the first page a merchant sees after install, and a
 * transient Admin API hiccup on one resource should degrade that section to a
 * neutral state rather than blanking the whole page behind an error boundary.
 * (Contracts in particular can hard-fail with ACCESS_DENIED until Protected
 * Customer Data is approved for the app — a real, expected state for a fresh
 * install, not a bug worth a 500.)
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  let programCount: number | null = null;
  let productsAttached = false;
  try {
    const programs = await listPrograms(admin);
    programCount = programs.length;
    productsAttached = programs.some((p) => (p.productCount ?? 0) > 0);
  } catch {
    programCount = null;
  }

  let contractCount: number | null = null;
  try {
    const contracts = await listContracts(admin);
    contractCount = contracts.length;
  } catch {
    contractCount = null;
  }

  return { programCount, productsAttached, contractCount };
};

export default function Index() {
  const { programCount, productsAttached, contractCount } =
    useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const hasProgram = (programCount ?? 0) > 0;
  const hasContract = (contractCount ?? 0) > 0;

  // Ordered setup steps. `done: null` means "couldn't determine" — shown as a
  // neutral step rather than a false negative that would nag a merchant who is
  // actually already set up.
  const steps: Array<{ done: boolean | null; title: string; body: string }> = [
    {
      done: programCount === null ? null : hasProgram,
      title: "Create a subscription program",
      body: hasProgram
        ? `${programCount} program${programCount === 1 ? "" : "s"} created.`
        : "Set the delivery frequency and any subscriber discount. This is what buyers pick at checkout.",
    },
    {
      done: programCount === null ? null : productsAttached,
      title: "Attach products to it",
      body: productsAttached
        ? "Products are attached — subscription options show on those product pages."
        : "Until at least one product is attached, no buyer can start a subscription.",
    },
    {
      done: contractCount === null ? null : hasContract,
      title: "Receive your first subscription",
      body: hasContract
        ? `${contractCount} active subscription${contractCount === 1 ? "" : "s"}. Billing renewals run automatically.`
        : "Once a buyer subscribes, their contract appears under Subscriptions and renews on schedule.",
    },
  ];

  return (
    <s-page heading="Marka Subscrify">
      {/* Never nest s-button inside s-link: the shadow-DOM button swallows the
          anchor's click and the link goes dead. Use a bare s-button that
          navigates programmatically instead. */}
      <s-button
        slot="primary-action"
        onClick={() => navigate("/app/programs/new")}
      >
        Create program
      </s-button>

      <s-section heading="Setup">
        {steps.map((step) => (
          <s-stack key={step.title} direction="inline" gap="base">
            <s-badge
              tone={
                step.done === null ? "info" : step.done ? "success" : "neutral"
              }
            >
              {step.done === null ? "—" : step.done ? "Done" : "To do"}
            </s-badge>
            <s-stack direction="block" gap="none">
              <s-text type="strong">{step.title}</s-text>
              <s-paragraph>{step.body}</s-paragraph>
            </s-stack>
          </s-stack>
        ))}
      </s-section>

      <s-section heading="Programs">
        <s-paragraph>
          {programCount === null
            ? "Couldn't load programs just now — open the Programs page to check."
            : hasProgram
              ? `You have ${programCount} subscription program${programCount === 1 ? "" : "s"}. Edit a program to change its frequency, discount, or which products offer it.`
              : "A program defines how often an order repeats and what subscribers pay. Create one to start offering subscriptions."}
        </s-paragraph>
        <s-button onClick={() => navigate("/app/programs")}>
          View programs
        </s-button>
      </s-section>

      <s-section heading="Subscriptions">
        <s-paragraph>
          {contractCount === null
            ? "Couldn't load subscriptions just now — open the Subscriptions page to check."
            : hasContract
              ? `${contractCount} subscription contract${contractCount === 1 ? "" : "s"}. Each one renews automatically on its billing date; open a contract to see its billing history.`
              : "No subscriptions yet. They'll appear here as buyers subscribe at checkout."}
        </s-paragraph>
        <s-button onClick={() => navigate("/app/contracts")}>
          View subscriptions
        </s-button>
      </s-section>

      <s-section slot="aside" heading="How billing works">
        <s-paragraph>
          Marka Subscrify charges each contract automatically on its billing date. If a
          payment fails, it retries after 3, then 5, then 7 days before marking
          the attempt as failed — and it will never charge the same billing cycle
          twice.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
