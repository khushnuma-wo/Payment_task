import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PaymentsGateway, PaymentRealtimeEvent } from './payments.gateway';
import { OUTBOX_CHANNEL } from '../outbox/outbox.service';

interface OutboxMessage {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: {
    paymentId?: string;
    userId?: string;
    status?: string;
    data?: unknown;
  };
}

/**
 * Bridges the outbox (Postgres -> Redis channel) to socket.io rooms.
 *
 * At-least-once: the outbox relay may re-deliver; emitting the same snapshot
 * twice to a websocket is harmless because it is idempotent for the client.
 */
@Injectable()
export class RealtimeBroadcaster implements OnModuleInit {
  private readonly logger = new Logger(RealtimeBroadcaster.name);
  private subscriber?: Redis;

  constructor(
    private readonly gateway: PaymentsGateway,
    config: ConfigService,
  ) {
    const cfg = config.get('redis');
    this.subscriber = new Redis({ host: cfg.host, port: cfg.port, db: cfg.db });
    // Without this, an unhandled 'error' event (e.g. Redis unreachable, retries
    // exhausted) throws and crashes the whole process.
    this.subscriber.on('error', (err) =>
      this.logger.warn(`subscriber error (non-fatal): ${err.message}`),
    );
  }

  async onModuleInit(): Promise<void> {
    this.subscriber!.subscribe(OUTBOX_CHANNEL, (err, count) => {
      if (err) this.logger.error(`subscribe failed: ${err.message}`);
      else this.logger.log(`subscribed to ${OUTBOX_CHANNEL} (${count} channels)`);
    });
    this.subscriber!.on('message', (chan, raw) => {
      this.logger.debug(`msg on ${chan}: ${String(raw).slice(0, 60)}`);
      this.route(raw);
    });
  }

  private route(raw: string): void {
    try {
      const msg = JSON.parse(raw) as OutboxMessage;
      if (msg.aggregateType !== 'payment' || !msg.payload?.paymentId) return;

      const evt: PaymentRealtimeEvent = {
        eventType: msg.eventType,
        paymentId: msg.payload.paymentId,
        status: msg.payload.status,
        userId: msg.payload.userId,
        data: msg.payload.data,
      };
      this.logger.debug(
        `routing ${evt.eventType} for ${evt.paymentId} -> rooms`,
      );
      this.gateway.broadcast(evt);
    } catch (e) {
      this.logger.warn(`malformed outbox message: ${(e as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.subscriber?.disconnect();
  }
}