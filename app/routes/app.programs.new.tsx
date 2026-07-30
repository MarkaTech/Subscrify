import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { redirect, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { ProgramForm, emptyPlan, type ProgramFormValue } from "../components/ProgramForm";
import { validateProgram, type ProgramConfig } from "../lib/selling-plans/program";
import { SellingPlanApiError, createProgram } from "../lib/selling-plans/api.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const config = JSON.parse(String(form.get("config") ?? "{}")) as ProgramConfig;
  const productIds = JSON.parse(String(form.get("productIds") ?? "[]")) as string[];

  const issues = validateProgram(config);
  if (issues.length) {
    return { errors: issues.map((i) => i.message) };
  }
  try {
    await createProgram(admin, config, productIds);
  } catch (error) {
    if (error instanceof SellingPlanApiError) {
      return { errors: error.userErrors.map((e) => e.message) };
    }
    throw error;
  }
  return redirect("/app/programs");
};

export default function NewProgram() {
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const errors = fetcher.data && "errors" in fetcher.data ? fetcher.data.errors : [];

  useEffect(() => {
    if (errors.length) shopify.toast.show("Could not save program", { isError: true });
  }, [errors, shopify]);

  const initial: ProgramFormValue = {
    config: {
      name: "Subscribe & Save",
      optionLabel: "Deliver every",
      plans: [emptyPlan()],
    },
    planIds: [null],
    productIds: [],
    productTitles: [],
  };

  return (
    <s-page heading="Create subscription program">
      <ProgramForm
        value={initial}
        errors={errors}
        submitting={fetcher.state !== "idle"}
        submitLabel="Create program"
        onSubmit={({ config, productIds }) =>
          fetcher.submit(
            { config: JSON.stringify(config), productIds: JSON.stringify(productIds) },
            { method: "POST" },
          )
        }
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
