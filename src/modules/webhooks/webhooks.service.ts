import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { Payment, PaymentStatus } from '../payments/entities/payment.entity';
import { PaymentEvent } from '../payments/entities/payment-event.entity';
import { OutboxEvent, OutboxStatus } from '../outbox/entities/outbox-event.entity';
import { GatewayWebhookDto, WebhookResponseDto } from './dto/gateway-webhook.dto';
import {
  GATEWAY_TO_PAYMENT_STATUS,
  GatewayWebhookType,
  PaymentEventType,
} from '../../common/constants/payment';
import { canTransition } from './payment-state-machine';
import { InvalidTransitionDomainError } from '../../common/errors/payment-errors';

export type WebhookDisposition = WebhookResponseDto['disposition'];

/**
 * Idempotent, transactional webhook processing.
 *
 * Correctness under concurrent duplicate delivery (two instances, same event):
 *  1. BEGIN (READ COMMITTED).
 *  2. INSERT payment_events ... ON CONFLICT (gateway_event_id) DO NOTHING.
 *     The first transaction inserts the row; any concurrent one either blocks
 *     on the uncommitted index entry then matches it, or races — in both cases
 *     exactly one tx observes 1 affected row. This is the *primary* dedupe fence
 *     and needs no Redis lock.
 *  3. SELECT ... FOR UPDATE on the payment row serializes different-but-legit
 *     events for the same payment.
 *  4. State-machine gate (no mutation out of terminal states).
 *  5. Update status + transaction id + insert outbox row.
 *  6. COMMIT. Everything is atomic: a crash rolls back all four writes, so
 *     partial updates (event stored but status not, etc.) are impossible.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly strategy: 'pessimistic' | 'optimistic';

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.strategy = config.get('locking.strategy') ?? 'pessimistic';
  }

  handleWebhook(dto: GatewayWebhookDto): Promise<WebhookResponseDto> {
    return this.processInTransaction(dto).then((disposition) => ({
      received: true,
      event_id: dto.id,
      disposition,
    }));
  }

  private async processInTransaction(
    dto: GatewayWebhookDto,
  ): Promise<WebhookDisposition> {
    const runner: QueryRunner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    try {
      const em = runner.manager;
      let payment: Payment | null;

      // ---- Fence 1: the unique gateway_event_id insert -------------------
      const won = await this.insertEventFenced(em, dto);
      if (!won) {
        await runner.commitTransaction();
        this.logger.debug(`Duplicate webhook ${dto.id} dropped`);
        return 'duplicate';
      }

      // ---- Fence 2: serialize this payment's row --------------------------
      payment =
        this.strategy === 'pessimistic'
          ? await em.findOne(Payment, {
              where: { id: dto.payment_id },
              lock: { mode: 'pessimistic_write' }, // SELECT ... FOR UPDATE
            })
          : await em.findOne(Payment, { where: { id: dto.payment_id } });

      if (!payment) {
        // Webhook arrived before the payment row existed. Roll back (removing
        // the event row too) and surface 404 so the gateway retries later.
        await runner.rollbackTransaction();
        throw new NotFoundException(
          `Payment ${dto.payment_id} does not exist yet`,
        );
      }

      const targetStatus = GATEWAY_TO_PAYMENT_STATUS[dto.event_type] as
        | PaymentStatus
        | undefined;
      if (!targetStatus) {
        await runner.commitTransaction();
        return 'ignored';
      }

      // ---- Fence 3: state machine -----------------------------------------
      if (!canTransition(payment.status, targetStatus)) {
        // Late/out-of-order event for a terminal payment. The event row stays
        // as an audit ledger, but state is left untouched.
        await runner.commitTransaction();
        this.logger.debug(
          `Ignored ${payment.status}->${targetStatus} for ${dto.payment_id}`,
        );
        return 'ignored';
      }

      // ---- Mutations ------------------------------------------------------
      if (this.strategy === 'optimistic') {
        const res = await em.update(
          Payment,
          { id: dto.payment_id, version: payment.version },
          {
            status: targetStatus,
            gatewayTransactionId:
              (dto.transaction_id ?? null) as Payment['gatewayTransactionId'],
          },
        );
        if (!res.affected) {
          await runner.rollbackTransaction();
          throw new InvalidTransitionDomainError(payment.status, targetStatus);
        }
      } else {
        payment.status = targetStatus;
        payment.gatewayTransactionId = dto.transaction_id ?? null;
        await em.save(payment);
      }

      // ---- Outbox write, same transaction as the mutation ----------------
      await em.save(
        em.create(OutboxEvent, {
          aggregateType: 'payment',
          aggregateId: dto.payment_id,
          eventType: this.toDomainEvent(dto.event_type),
          payload: {
            paymentId: dto.payment_id,
            userId: payment.userId,
            status: targetStatus,
            gatewayEventId: dto.id,
            transactionId: dto.transaction_id ?? null,
            eventTime: dto.event_time ?? null,
            data: dto.data,
          },
          status: OutboxStatus.PENDING,
          partitionKey: `payment:${dto.payment_id}`,
        }),
      );

      await runner.commitTransaction();
      this.logger.log(
        `Payment ${dto.payment_id} -> ${targetStatus} via event ${dto.id}`,
      );
      return 'accepted';
    } catch (err) {
      try {
        await runner.rollbackTransaction();
      } catch {
        /* already rolled back */
      }
      throw err;
    } finally {
      await runner.release();
    }
  }

  /**
   * Insert the payment_event with ON CONFLICT DO NOTHING. Returns true iff this
   * transaction inserted the row (i.e. this was the first, authoritative copy).
   */
  private async insertEventFenced(
    em: EntityManager,
    dto: GatewayWebhookDto,
  ): Promise<boolean> {
    const result = await em
      .createQueryBuilder()
      .insert()
      .into(PaymentEvent)
      .values({
        paymentId: dto.payment_id,
        gatewayEventId: dto.id,
        eventType: dto.event_type,
        payload: {
          ...dto.data,
          ...(dto.transaction_id ? { transaction_id: dto.transaction_id } : {}),
        },
      } as any)
      .orIgnore() // ON CONFLICT (gateway_event_id) DO NOTHING
      .execute();
    // Rely on the rows actually RETURNED by the driver: with
    // ON CONFLICT DO NOTHING a conflicted/skipped insert yields zero returned
    // rows, while both `identifiers` and `generatedMaps` are populated even for
    // skipped rows and must NOT be used as the authoritative signal.
    const rawRows = Array.isArray(result.raw) ? result.raw : [];
    return rawRows.length > 0;
  }

  private toDomainEvent(gatewayType: string): string {
    switch (gatewayType) {
      case GatewayWebhookType.PAYMENT_PROCESSING:
        return PaymentEventType.PAYMENT_PROCESSING;
      case GatewayWebhookType.PAYMENT_SUCCEEDED:
        return PaymentEventType.PAYMENT_SUCCEEDED;
      case GatewayWebhookType.PAYMENT_FAILED:
        return PaymentEventType.PAYMENT_FAILED;
      case GatewayWebhookType.PAYMENT_CANCELLED:
        return PaymentEventType.PAYMENT_CANCELLED;
      default:
        return PaymentEventType.PAYMENT_CREATED;
    }
  }
}