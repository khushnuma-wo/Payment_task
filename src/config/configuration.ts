/**
 * Central, strongly-typed configuration.
 * All environment variables flow through here so that consumers never touch
 * process.env directly and are unit-testable.
 */
export interface AppOptions {
  nodeEnv: string;
  port: number;
  logLevel: string;
}

export interface PostgresOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  // Extra connectivity params shared with TypeORM.
  poolSize: number;
  statementTimeoutMs: number;
}

export interface RedisOptions {
  host: string;
  port: number;
  db: number;
  ttlSeconds: number; // caching TTL
}

export interface AuthOptions {
  jwtSecret: string;
  jwtExpiresIn: string;
}

export interface WebhookOptions {
  secret: string;
}

export interface LockingOptions {
  strategy: 'pessimistic' | 'optimistic';
}

export interface JobOptions {
  stuckPaymentScanMs: number;
  stuckPaymentMaxAgeMs: number;
}

export interface Features {
  websocketEnabled: boolean;
}

const int = (v: string | undefined, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

export const configuration = () => ({
  app: {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: int(process.env.PORT, 3000),
    logLevel: process.env.LOG_LEVEL ?? 'info',
  } as AppOptions,
  postgres: {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: int(process.env.POSTGRES_PORT, 5432),
    user: process.env.POSTGRES_USER ?? 'payment',
    password: process.env.POSTGRES_PASSWORD ?? 'payment',
    database: process.env.POSTGRES_DB ?? 'payment',
    poolSize: int(process.env.POSTGRES_POOL_SIZE, 20),
    statementTimeoutMs: int(process.env.POSTGRES_STATEMENT_TIMEOUT_MS, 5000),
  } as PostgresOptions,
  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: int(process.env.REDIS_PORT, 6379),
    db: int(process.env.REDIS_DB, 0),
    ttlSeconds: int(process.env.REDIS_TTL_SECONDS, 120),
  } as RedisOptions,
  auth: {
    jwtSecret: process.env.JWT_SECRET ?? 'insecure-dev-secret',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
  } as AuthOptions,
  webhook: {
    secret: process.env.WEBHOOK_SECRET ?? 'insecure-dev-webhook-secret',
  } as WebhookOptions,
  locking: {
    strategy: (process.env.LOCKING_STRATEGY === 'optimistic'
      ? 'optimistic'
      : 'pessimistic') as 'pessimistic' | 'optimistic',
  } as LockingOptions,
  jobs: {
    stuckPaymentScanMs: int(process.env.STUCK_PAYMENT_SCAN_MS, 60000),
    stuckPaymentMaxAgeMs: int(process.env.STUCK_PAYMENT_MAX_AGE_MS, 300000),
  } as JobOptions,
  features: {
    websocketEnabled: (process.env.WEBSOCKET_ENABLED ?? 'true') === 'true',
  } as Record<'websocketEnabled', boolean>,
});