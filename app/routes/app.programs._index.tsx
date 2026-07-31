import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Link, useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { deleteProgram, listPrograms } from "../lib/selling-plans/api.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const programs = await listPrograms(admin);
  return { programs };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") === "delete") {
    const id = String(form.get("id") ?? "");
    if (id) await deleteProgram(admin, id);
    return { deleted: id };
  }
  return null;
};

export default function ProgramsIndex() {
  const { programs } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const deleting = fetcher.state !== "idle";

  return (
    <s-page heading="Subscription programs">
      {/* Never nest s-button inside s-link: the shadow-DOM button swallows
          the click and the link never fires. Navigate programmatically. */}
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => navigate("/app/programs/new")}
      >
        Create program
      </s-button>

      {programs.length === 0 ? (
        <s-section heading="No programs yet">
          <s-paragraph>
            A program is a set of subscription plans buyers choose from — for
            example “Subscribe &amp; Save: deliver every 1, 2, or 4 weeks at 10%
            off”. Create your first program and attach it to products.
          </s-paragraph>
          <s-button
            variant="primary"
            onClick={() => navigate("/app/programs/new")}
          >
            Create your first program
          </s-button>
        </s-section>
      ) : (
        <s-section heading={`${programs.length} program(s)`}>
          <s-table>
            <s-table-header-row>
              <s-table-header>Program</s-table-header>
              <s-table-header>Plans</s-table-header>
              <s-table-header>Products</s-table-header>
              <s-table-header>Summary</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {programs.map((program) => (
                <s-table-row key={program.id}>
                  <s-table-cell>
                    <Link to={`/app/programs/${encodeURIComponent(program.id)}`}>
                      {program.name}
                    </Link>
                  </s-table-cell>
                  <s-table-cell>{program.planCount}</s-table-cell>
                  <s-table-cell>{program.productCount}</s-table-cell>
                  <s-table-cell>{program.summary ?? ""}</s-table-cell>
                  <s-table-cell>
                    <s-button
                      tone="critical"
                      variant="tertiary"
                      {...(deleting ? { disabled: true } : {})}
                      onClick={() =>
                        fetcher.submit({ intent: "delete", id: program.id }, { method: "POST" })
                      }
                    >
                      Delete
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
