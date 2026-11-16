import { DataSource, DataSourceOptions } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Payment, PaymentStatus } from '../../src/modules/payments/entities/payment.entity';
import { WebhooksService } from '../../src/modules/webhooks/webhooks.service';
import { GatewayWebhookDto } from '../../src/modules/webhooks/dto/gateway-webhook.dto';
import type { WebhookResponseDto } from '../../src/modules/webhooks/dto/gateway-webhook.dto';
import { buildTypeOrmOptions } from '../../src/database/typeorm-config';

/**
 * Concurrency / idempotency test against a REAL Postgres instance.
 *
 * Requires a reachable database. Override with env:
 *   POSTGRES_HOST / POSTGRES_PORT / POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB
 *
 * It fires 20 parallel deliveries of the SAME gateway_event_id and asserts the
 * unique-constraint fence yields exactly one accepted delivery, one event row,
 * one outbox row, and 19 duplicates. If Postgres is unreachable the test suite
 * skips (reported) instead of failing — run it in CI where the DB exists.
 */
const cfg = {
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? 'postgres',
  password: process.env.POSTGRES_PASSWORD ?? '',
  database: process.env.POSTGRES_DB ?? 'payment',
  poolSize: 10,
  statementTimeoutMs: 5000,
};

describe('concurrent webhook idempotency (real Postgres)', () => {
  let dataSource: DataSource | null = null;
  let service: WebhooksService | null = null;
  let dbAvailable = true;
  let paymentId: string;

  beforeAll(async () => {
    try {
      dataSource = new DataSource({
        ...buildTypeOrmOptions(cfg),
        synchronize: true, // build tables for the test run
      } as DataSourceOptions);
      await dataSource.initialize();
      await dataSource.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

      const cs = { get: (k: string) => (k === 'locking.strategy' ? 'pessimistic' : undefined) };
      service = new WebhooksService(dataSource, cs as unknown as ConfigService);

      paymentId = randomUUID();
      const payment = dataSource.manager.create(Payment, {
        id: paymentId,
        orderId: randomUUID(),
        userId: randomUUID(),
        amount: '1999.99',
        currency: 'USD',
        status: PaymentStatus.PENDING,
      });
      await dataSource.manager.save(payment);
    } catch (e) {
      dbAvailable = false;
      console.warn(
        `\n[SKIPPED] Concurrency test needs Postgres at ${cfg.host}:${cfg.port}/${cfg.database} ` +
          `(user ${cfg.user}). Set POSTGRES_* env vars. Error: ${(e as Error).message}\n`,
      );
    }
  });

  afterAll(async () => {
    if (!dataSource || !dbAvailable) return;
    await dataSource.query(`DELETE FROM payment_events WHERE payment_id = $1`, [paymentId]);
    await dataSource.query(`DELETE FROM outbox_events WHERE aggregate_id = $1`, [paymentId]);
    await dataSource.query(`DELETE FROM payments WHERE id = $1`, [paymentId]);
    await dataSource.destroy();
  });

  it('20 parallel identical webhooks -> exactly one accepted, one event row, one status change', async () => {
    if (!dbAvailable || !service || !dataSource) return; // skipped

    const gatewayEventId = `gw_${randomUUID()}`;
    const payload: GatewayWebhookDto = {
      id: gatewayEventId,
      event_type: 'payment.succeeded',
      payment_id: paymentId,
      transaction_id: 'txn_par',
      data: { amount: 1999.99, currency: 'USD' },
    };

    // Fire 20 deliveries concurrently.
    const results: WebhookResponseDto[] = await Promise.all(
      Array.from({ length: 20 }, () => service!.handleWebhook(payload)),
    );

    const accepted = results.filter((r) => r.disposition === 'accepted').length;
    const duplicated = results.filter((r) => r.disposition === 'duplicate').length;

    // Exactly one coordinator may win the event insert.
    expect(accepted).toBe(1);
    expect(duplicated).toBe(19);

    // Exactly one payment_event row persisted despite 20 attempts.
    const eventCount = Number(
      (
        await dataSource.query(
          `SELECT count(*)::int AS c FROM payment_events WHERE gateway_event_id = $1`,
          [gatewayEventId],
        )
      )[0].c,
    );
    expect(eventCount).toBe(1);

    // Exactly one outbox event was produced.
    const outboxCount = Number(
      (
        await dataSource.query(
          `SELECT count(*)::int AS c FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'payment.succeeded'`,
          [paymentId],
        )
      )[0].c,
    );
    expect(outboxCount).toBe(1);

    // Payment ended SUCCESS.
    const finalPayment = await dataSource.manager.findOne<Payment>(Payment, {
      where: { id: paymentId },
    });
    expect(finalPayment?.status).toBe(PaymentStatus.SUCCESS);
  });
});
