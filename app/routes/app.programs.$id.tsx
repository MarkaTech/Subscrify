import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { redirect, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { ProgramForm, type ProgramFormValue } from "../components/ProgramForm";
import {
  validateProgram,
  type DeliveryInterval,
  type PlanConfig,
  type ProgramConfig,
} from "../lib/selling-plans/program";
import {
  SellingPlanApiError,
  getProgram,
  setProgramProducts,
  updateProgram,
} from "../lib/selling-plans/api.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const program = await getProgram(admin, params.id!);
  if (!program) {
    throw new Response("Program not found", { status: 404 });
  }
  return { program };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const groupId = params.id!;
  const form = await request.formData();
  const config = JSON.parse(String(form.get("config") ?? "{}")) as ProgramConfig;
  const planIds = JSON.parse(String(form.get("planIds") ?? "[]")) as Array<string | null>;
  const productIds = JSON.parse(String(form.get("productIds") ?? "[]")) as string[];
  const currentPlanIds = JSON.parse(String(form.get("currentPlanIds") ?? "[]")) as string[];
  const currentProductIds = JSON.parse(String(form.get("currentProductIds") ?? "[]")) as string[];

  const issues = validateProgram(config);
  if (issues.length) {
    return { errors: issues.map((i) => i.message) };
  }
  try {
    await updateProgram(admin, groupId, config, planIds, currentPlanIds);
    await setProgramProducts(admin, groupId, productIds, currentProductIds);
  } catch (error) {
    if (error instanceof SellingPlanApiError) {
      return { errors: error.userErrors.map((e) => e.message) };
    }
    throw error;
  }
  return redirect("/app/programs");
};

/** Reconstruct editable PlanConfig from what Shopify stored. */
function planFromDetail(plan: {
  name: string;
  optionLabel: string;
  billing: { interval: string; intervalCount: number } | null;
  delivery: { interval: string; intervalCount: number } | null;
  pricingSummary: string;
}): PlanConfig {
  const delivery = plan.delivery ?? { interval: "MONTH", intervalCount: 1 };
  const billing = plan.billing ?? delivery;
  const deliveriesPerCharge =
    billing.interval === delivery.interval && delivery.intervalCount > 0
      ? Math.max(1, Math.round(billing.intervalCount / delivery.intervalCount))
      : 1;
  const percentMatch = /^([\d.]+)% off$/.exec(plan.pricingSummary);
  const amountMatch = /^([\d.]+) [A-Z]{3} off$/.exec(plan.pricingSummary);
  return {
    name: plan.name,
    optionLabel: plan.optionLabel,
    deliveryInterval: delivery.interval as DeliveryInterval,
    deliveryIntervalCount: delivery.intervalCount,
    deliveriesPerCharge,
    discount: percentMatch
      ? { type: "PERCENTAGE", value: Number(percentMatch[1]) }
      : amountMatch
        ? { type: "AMOUNT", value: Number(amountMatch[1]) }
        : { type: "NONE" },
  };
}

export default function EditProgram() {
  const { program } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const errors = fetcher.data && "errors" in fetcher.data ? fetcher.data.errors : [];

  useEffect(() => {
    if (errors.length) shopify.toast.show("Could not save changes", { isError: true });
  }, [errors, shopify]);

  const initial: ProgramFormValue = {
    config: {
      name: program.name,
      merchantCode: program.merchantCode,
      optionLabel: program.optionLabel,
      plans: program.plans.map(planFromDetail),
    },
    planIds: program.plans.map((p) => p.id),
    productIds: program.productIds,
    productTitles: program.productTitles,
  };

  return (
    <s-page heading={`Edit: ${program.name}`}>
      <ProgramForm
        value={initial}
        errors={errors}
        submitting={fetcher.state !== "idle"}
        submitLabel="Save changes"
        onSubmit={({ config, planIds, productIds }) =>
          fetcher.submit(
            {
              config: JSON.stringify(config),
              planIds: JSON.stringify(planIds),
              productIds: JSON.stringify(productIds),
              currentPlanIds: JSON.stringify(program.plans.map((p) => p.id)),
              currentProductIds: JSON.stringify(program.productIds),
            },
            { method: "POST" },
          )
        }
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
