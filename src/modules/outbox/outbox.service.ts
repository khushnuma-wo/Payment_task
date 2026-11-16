import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { OutboxEvent, OutboxStatus } from './entities/outbox-event.entity';
import { RedisService } from '../../infrastructure/redis/redis.service';

export const OUTBOX_CHANNEL = 'payment.events';

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 1_000;
const BATCH_SIZE = 100;
const CLAIM_TIMEOUT_MS = 30_000;

/**
 * Outbox relay: claims committed PENDING outbox rows and publishes them to the
 * Redis pub/sub channel that feeds the socket.io adapter across all instances.
 *
 * Single-worker-per-event is guaranteed by an atomic claim (UPDATE ... WHERE
 * status='PENDING' ... RETURNING), NOT by a Redis lock — the database enforces
 * that only one relay claims a row. This is at-least-once delivery: a crash
 * after publish but before marking PUBLISHED re-delivers, which downstream
 * websocket clients and any consumer must treat as idempotent.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    @InjectRepository(OutboxEvent)
    private readonly repo: Repository<OutboxEvent>,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  /** Start the polling relay. Called on module init. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.relayOnce().catch((e) =>
        this.logger.warn(`relay tick failed: ${(e as Error).message}`),
      );
    }, 500);
    this.timer.unref();
    void this.relayOnce();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async relayOnce(): Promise<number> {
    const claimed = await this.claimBatch();
    if (claimed.length === 0) return 0;

    for (const ev of claimed) {
      await this.publish(ev);
    }
    return claimed.length;
  }

  /**
   * Atomically claim up to batch size publishable events using a lease in
   * `availableAfter`. Only one instance can flip a row PENDING -> PROCESSING,
   * so a single worker (the one that successfully claimed) publishes it.
   * Rows whose PROCESSING lease has expired are re-claimed for recovery.
   * Postgres does not allow LIMIT in UPDATE, so we select ids in a subquery.
   */
  private async claimBatch(): Promise<OutboxEvent[]> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + CLAIM_TIMEOUT_MS);
    const result = await this.repo
      .createQueryBuilder()
      .update(OutboxEvent)
      .set({ status: OutboxStatus.PROCESSING, availableAfter: leaseUntil })
      .where(
        `id IN (
           SELECT id FROM outbox_events
           WHERE status = :pending OR (status = :processing AND availableAfter <= :now)
           ORDER BY created_at
           LIMIT :batch
         )`,
        { pending: OutboxStatus.PENDING, processing: OutboxStatus.PROCESSING, now, batch: BATCH_SIZE },
      )
      .returning('*')
      .execute();
    // TypeORM returns raw rows keyed by the DB column names (snake_case), so
    // map them back onto the entity shape before publishing.
    return ((result.raw ?? []) as Record<string, unknown>[]).map((r) =>
      this.repo.create({
        id: r.id as string,
        aggregateType: r.aggregate_type as string,
        aggregateId: r.aggregate_id as string,
        eventType: r.event_type as string,
        partitionKey: r.partition_key as string | null,
        payload: r.payload as Record<string, unknown>,
        status: r.status as OutboxStatus,
        attempts: Number(r.attempts ?? 0),
        publishedAt: r.published_at as Date | null,
        lastError: r.last_error as string | null,
        availableAfter: r.available_after as Date | null,
      }),
    );
  }

  private async publish(ev: OutboxEvent): Promise<void> {
    const message = JSON.stringify({
      aggregateType: ev.aggregateType,
      aggregateId: ev.aggregateId,
      eventType: ev.eventType,
      partitionKey: ev.partitionKey,
      payload: ev.payload,
      publishedAt: new Date().toISOString(),
    });

    try {
      await this.redis.publish(OUTBOX_CHANNEL, message);
      await this.repo.update(
        { id: ev.id, status: OutboxStatus.PROCESSING },
        { status: OutboxStatus.PUBLISHED, publishedAt: new Date(), attempts: ev.attempts + 1 },
      );
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn(`outbox publish failed for ${ev.id}: ${msg}`);
      const attempts = ev.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        // Dead-letter: stop retrying, surface for a reconciliation job.
        await this.repo.update(
          { id: ev.id },
          {
            status: OutboxStatus.FAILED,
            attempts,
            lastError: msg,
            availableAfter: new Date(Date.now() + CLAIM_TIMEOUT_MS),
          },
        );
      } else {
        await this.repo.update(
          { id: ev.id },
          {
            status: OutboxStatus.PENDING,
            attempts,
            lastError: msg,
            availableAfter: new Date(Date.now() + BASE_BACKOFF_MS * 2 ** attempts),
          },
        );
      }
    }
  }

  // ---- used by tests / ops -------------------------------------------------
  async deadLettered(): Promise<OutboxEvent[]> {
    return this.repo.find({ where: { status: OutboxStatus.FAILED }, take: 100 });
  }

  async requeueDeadLettered(ids: string[]): Promise<void> {
    await this.repo.update(
      { id: In(ids), status: OutboxStatus.FAILED },
      { status: OutboxStatus.PENDING, attempts: 0, lastError: null, availableAfter: null },
    );
  }
}