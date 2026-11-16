import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, QueryRunner } from 'typeorm';
import { WebhooksService } from '../../src/modules/webhooks/webhooks.service';
import { GatewayWebhookDto } from '../../src/modules/webhooks/dto/gateway-webhook.dto';
import { Payment, PaymentStatus } from '../../src/modules/payments/entities/payment.entity';

/**
 * A hand-rolled fake QueryRunner that lets each test control what the fenced
 * insert returns. This isolates the service's decision logic:
 *   - 'duplicate' when the fence says another tx already wrote the event
 *   - 'accepted' when this tx won the fence
 *   - 'ignored' for terminal-state violations / unknown event types
 *   - NotFoundException when the payment row is absent
 */
function buildService(opts: {
  insertWins?: boolean;
  payment?: Payment | null;
  onCommit?: () => void;
  transitions?: { from: PaymentStatus; to: PaymentStatus }[];
}): WebhooksService {
  const payment =
    opts.payment ??
    Object.assign(new Payment(), {
      id: 'p1',
      status: PaymentStatus.PENDING,
      userId: 'u1',
      version: 1,
    });

  interface FakeInsert {
    insert(): FakeInsert;
    into(): FakeInsert;
    values(): FakeInsert;
    orIgnore(): FakeInsert;
    execute(): Promise<{ identifiers: unknown[]; raw: unknown[] }>;
  }
  const fakeBuilder: FakeInsert = {
    insert: jest.fn(function () {
      return fakeBuilder;
    }),
    into: jest.fn(function () {
      return fakeBuilder;
    }),
    values: jest.fn(function () {
      return fakeBuilder;
    }),
    orIgnore: jest.fn(function () {
      return fakeBuilder;
    }),
    execute: jest.fn(async () => ({
      identifiers: opts.insertWins === false ? [] : [{ id: 'evt_1' }],
      raw: opts.insertWins === false ? [] : [{ id: 'evt_1' }],
    })),
  };

  const fakeManager = {
    createQueryBuilder: jest.fn(() => fakeBuilder),
    findOne: jest.fn(async () => (opts.payment === undefined ? payment : opts.payment)),
    update: jest.fn(async () => ({ affected: 1 })),
    save: jest.fn(async (e: any) => e),
    create: jest.fn((_e: any, data: any) => data),
  };

  const runner = {
    connect: jest.fn(async () => undefined),
    startTransaction: jest.fn(async () => undefined),
    commitTransaction: jest.fn(async () => opts.onCommit?.()),
    rollbackTransaction: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    manager: fakeManager,
  } as unknown as QueryRunner;

  const dataSource = {
    createQueryRunner: jest.fn(() => runner),
  } as unknown as DataSource;

  const config = {
    get: jest.fn((key: string) => (key === 'locking.strategy' ? 'pessimistic' : undefined)),
  } as unknown as ConfigService;

  return new WebhooksService(dataSource, config);
}

function webhook(overrides: Partial<GatewayWebhookDto> = {}): GatewayWebhookDto {
  return {
    id: 'gateway_evt_1',
    event_type: 'payment.succeeded',
    payment_id: 'p1',
    transaction_id: 'txn_123',
    data: { amount: 100, currency: 'USD' },
    ...overrides,
  };
}

describe('WebhooksService idempotency decisions', () => {
  it('accepts a webhook when this transaction wins the fence', async () => {
    const svc = buildService({ insertWins: true });
    const res = await svc.handleWebhook(webhook());
    expect(res.disposition).toBe('accepted');
  });

  it('returns duplicate when another tx already inserted the event', async () => {
    const svc = buildService({ insertWins: false });
    const res = await svc.handleWebhook(webhook());
    expect(res.disposition).toBe('duplicate');
  });

  it('throws NotFoundException when the payment does not exist', async () => {
    const svc = buildService({ insertWins: true, payment: null });
    await expect(svc.handleWebhook(webhook())).rejects.toThrow(NotFoundException);
  });

  it('ignores events that would mutate a terminal payment', async () => {
    const terminal = Object.assign(new Payment(), {
      id: 'p1',
      status: PaymentStatus.SUCCESS,
      userId: 'u1',
      version: 3,
    });
    const svc = buildService({ insertWins: true, payment: terminal });
    // Late FAILED event after SUCCESS must not flip the payment.
    const res = await svc.handleWebhook(webhook({ event_type: 'payment.failed' }));
    expect(res.disposition).toBe('ignored');
  });

  it('responds 200 (no throw) even for duplicates so gateways stop retrying', async () => {
    const svc = buildService({ insertWins: false });
    const res = await svc.handleWebhook(webhook());
    expect(res.received).toBe(true);
    expect(res.disposition).toBe('duplicate');
  });
});
