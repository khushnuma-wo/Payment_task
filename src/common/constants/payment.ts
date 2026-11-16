/** Canonical event-type vocabulary shared across services and messages. */
export const PaymentEventType = {
  PAYMENT_CREATED: 'payment.created',
  PAYMENT_PROCESSING: 'payment.processing',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_CANCELLED: 'payment.cancelled',
} as const;

export type PaymentEventTypeName =
  (typeof PaymentEventType)[keyof typeof PaymentEventType];

/** Gateway webhook event types we accept. */
export const GatewayWebhookType = {
  PAYMENT_CREATED: 'payment.created',
  PAYMENT_PROCESSING: 'payment.processing',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_CANCELLED: 'payment.cancelled',
} as const;

export const GATEWAY_WEBHOOK_TYPES: string[] = Object.values(GatewayWebhookType);

/** Mapping from gateway event -> final-ish payment status transition. */
export const GATEWAY_TO_PAYMENT_STATUS: Record<string, string> = {
  [GatewayWebhookType.PAYMENT_PROCESSING]: 'PROCESSING',
  [GatewayWebhookType.PAYMENT_SUCCEEDED]: 'SUCCESS',
  [GatewayWebhookType.PAYMENT_FAILED]: 'FAILED',
  [GatewayWebhookType.PAYMENT_CANCELLED]: 'CANCELLED',
};