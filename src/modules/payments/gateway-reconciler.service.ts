import { Injectable, Logger } from '@nestjs/common';
import { Payment } from './entities/payment.entity';
import { PaymentStatusReconciler } from './reconciliation.service';

/**
 * Default reconciler: without a real gateway SDK wired in, this only logs.
 * Integrate a gateway client (Stripe/Adyen) that, on finding the authoritative
 * status, synthesizes the same GatewayWebhookDto and calls
 * `webhooksService.handleWebhook` so the idempotency machinery is reused.
 */
@Injectable()
export class DefaultGatewayReconciler implements PaymentStatusReconciler {
  private readonly logger = new Logger(DefaultGatewayReconciler.name);

  async requestStatusFromGateway(payment: Payment): Promise<void> {
    this.logger.warn(
      `[reconcile] would re-query gateway for payment ${payment.id} (${payment.status})`,
    );
  }
}