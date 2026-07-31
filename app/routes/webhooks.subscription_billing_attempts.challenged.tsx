import { createBillingAttemptWebhookAction } from "../lib/billing/webhook-handler.server";

export const action = createBillingAttemptWebhookAction("challenged");
