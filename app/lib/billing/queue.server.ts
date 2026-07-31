/**
 * Service Bus wiring for the billing-attempts queue (Phase 4 billing engine).
 *
 * Every message's Service Bus `messageId` is set to the billing attempt's
 * idempotency key. That turns on the queue's `requiresDuplicateDetection`
 * (see infra/main.bicep) as a second wall against double-charging, alongside
 * the local Postgres unique constraint (store.server.ts) and Shopify's own
 * idempotencyKey on the charge mutation.
 */

import {
  ServiceBusClient,
  type ServiceBusReceivedMessage,
} from "@azure/service-bus";

const QUEUE_NAME = "billing-attempts";

export interface BillingAttemptMessage {
  shop: string;
  subscriptionContractGid: string;
  billingCycleIndex: number;
  attemptNumber: number;
  idempotencyKey: string;
}

let sharedClient: ServiceBusClient | null = null;

function getClient(): ServiceBusClient {
  if (!sharedClient) {
    const connectionString = process.env.SERVICEBUS_CONNECTION;
    if (!connectionString) {
      throw new Error(
        "SERVICEBUS_CONNECTION is not configured — the billing engine cannot enqueue or receive billing attempts without it.",
      );
    }
    sharedClient = new ServiceBusClient(connectionString);
  }
  return sharedClient;
}

/**
 * Enqueue one billing attempt. Pass scheduledEnqueueTimeUtc for dunning
 * retries (Standard-tier Service Bus holds the message until then); omit it
 * for the original, immediate attempt.
 */
export async function sendBillingAttemptMessage(
  message: BillingAttemptMessage,
  options?: { scheduledEnqueueTimeUtc?: Date },
): Promise<void> {
  const sender = getClient().createSender(QUEUE_NAME);
  try {
    await sender.sendMessages({
      body: message,
      messageId: message.idempotencyKey,
      contentType: "application/json",
      ...(options?.scheduledEnqueueTimeUtc
        ? { scheduledEnqueueTimeUtc: options.scheduledEnqueueTimeUtc }
        : {}),
    });
  } finally {
    await sender.close();
  }
}

/** Runtime shape check — the message crossed a network boundary, don't trust it blindly. */
export function parseBillingAttemptMessage(body: unknown): BillingAttemptMessage {
  const b = body as Partial<BillingAttemptMessage> | null;
  if (
    typeof b !== "object" ||
    b === null ||
    typeof b.shop !== "string" ||
    typeof b.subscriptionContractGid !== "string" ||
    typeof b.billingCycleIndex !== "number" ||
    typeof b.attemptNumber !== "number" ||
    typeof b.idempotencyKey !== "string"
  ) {
    throw new Error(
      `billing-attempts message has an unexpected shape: ${JSON.stringify(body)}`,
    );
  }
  return {
    shop: b.shop,
    subscriptionContractGid: b.subscriptionContractGid,
    billingCycleIndex: b.billingCycleIndex,
    attemptNumber: b.attemptNumber,
    idempotencyKey: b.idempotencyKey,
  };
}

/**
 * Start consuming the billing-attempts queue. autoCompleteMessages stays at
 * its default (true): if `handleMessage` throws, the message is abandoned
 * and Service Bus redelivers it (up to maxDeliveryCount=5 before
 * dead-lettering — see the DLQ alert in infra/main.bicep); if it resolves,
 * the message is completed. That default is exactly the behavior worker
 * wants — genuine transport/infra errors should be retried by Service Bus,
 * while Shopify-side business outcomes (success/failure/challenged) are
 * always resolved without throwing and handled via our own dunning policy
 * instead (see dunning.server.ts), not via queue redelivery.
 */
export function subscribeBillingAttempts(handlers: {
  handleMessage: (
    message: BillingAttemptMessage,
    raw: ServiceBusReceivedMessage,
  ) => Promise<void>;
  handleError: (err: unknown) => Promise<void>;
}): { close: () => Promise<void> } {
  const receiver = getClient().createReceiver(QUEUE_NAME, {
    receiveMode: "peekLock",
  });

  const subscription = receiver.subscribe(
    {
      processMessage: async (raw) => {
        await handlers.handleMessage(parseBillingAttemptMessage(raw.body), raw);
      },
      processError: async (args) => {
        await handlers.handleError(args.error);
      },
    },
    { maxConcurrentCalls: 4 },
  );

  return {
    close: async () => {
      await subscription.close();
      await receiver.close();
    },
  };
}

export async function closeServiceBusClient(): Promise<void> {
  if (sharedClient) {
    await sharedClient.close();
    sharedClient = null;
  }
}
