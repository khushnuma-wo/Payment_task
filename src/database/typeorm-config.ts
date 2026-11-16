import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { PostgresOptions } from '../config/configuration';
import { Payment } from '../modules/payments/entities/payment.entity';
import { PaymentEvent } from '../modules/payments/entities/payment-event.entity';
import { OutboxEvent } from '../modules/outbox/entities/outbox-event.entity';

/**
 * Postgres is the source of truth. We configure:
 *  - modest statement timeout so a hung query fails fast rather than holding a row lock
 *  - optimistic concurrency is off by default (see webhook handler which uses pessimistic)
 */
export const buildTypeOrmOptions = (
  cfg: PostgresOptions,
): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: cfg.host,
  port: cfg.port,
  username: cfg.user,
  password: cfg.password,
  database: cfg.database,
  entities: [Payment, PaymentEvent, OutboxEvent],
  synchronize: false, // migrations in production
  autoLoadEntities: true,
  poolSize: cfg.poolSize,
  extra: { statement_timeout: cfg.statementTimeoutMs },
  logging: ['error', 'warn'],
  retryAttempts: 5,
  retryDelay: 1000,
});