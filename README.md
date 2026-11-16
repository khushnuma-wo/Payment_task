# Payment Processing Service

Production-grade, horizontally-scalable payment processing backend for an
e-commerce platform. Node.js + NestJS + PostgreSQL + Redis + TypeORM + Socket.IO.

PostgreSQL is the **source of truth** for all financial state. Redis is used only
where it adds real value (cross-instance websocket fan-out, optional caching).
Idempotency is enforced by **database constraints**, not by distributed locks.

---

## 1. System Architecture

> **Deliverables:** architecture diagram → [`docs/architecture.md`](docs/architecture.md)
> · design decisions → [`docs/design-decisions.md`](docs/design-decisions.md).

```
┌────────────┐   HTTPS/WS     ┌────────────────────┐
│   Client   │───────────────▶│  Load Balancer     │  (NLB / HAProxy)
└────────────┘                └─────────┬──────────┘
                                        │
                  ┌─────────────────────┼─────────────────────┐
                  ▼                     ▼                     ▼
            ┌──────────┐         ┌──────────┐         ┌──────────┐
            │  API #1  │         │  API #2  │         │  API #N  │
            │ (NestJS) │         │ (NestJS) │         │ (NestJS) │
            │ socket.io│         │ socket.io│         │ socket.io│
            └────┬─────┘         └────┬─────┘         └────┬─────┘
                 │   (SELECT FOR UPDATE, unique fence)     │
                 └──────────────┬─────┴─────────────────────┘
                                │
                     ┌──────────▼──────────┐       ┌──────────────┐
                     │     PostgreSQL      │◀─────▶│    Redis     │
                     │  payments           │ pub/  │  pub/sub     │
                     │  payment_events     │ sub   │  (socket.io  │
                     │  outbox_events      │──────▶│   adapter +  │
                     └─────────────────────┘  msg  │   channel)   │
                                                   └──────────────┘

    Payment Gateway  ──(signed webhook, N retries)──▶  LB ─▶ any API instance
```

### Request flow (create payment)
1. Client `POST /payments` → LB → one API instance.
2. Instance validates DTO, opens a transaction, inserts `payments` row
   (`PENDING`) **and** an `outbox_events` row (`payment.created`), commits.
3. Instance returns the payment JSON; client connects over WS and subscribes
   to `payment:<id>`.
4. The **outbox relay** polls `outbox_events`, publishes the event to the Redis
   channel `payment.events`, then marks the row `PUBLISHED`.

### Webhook flow (gateway → status change)
1. Gateway signs body (`HMAC-SHA256`) and retries until it gets `200`.
2. Any instance verifies the signature, then runs the idempotent transaction
   (see §4): insert `payment_events` with `ON CONFLICT DO NOTHING`, lock the
   payment row, run the state machine, update status, insert outbox row, commit.
3. Outbox relay publishes `payment.succeeded` to Redis.
4. The socket.io **Redis pub/sub adapter** delivers the message to every
   instance; the instance holding the subscribed clients emits
   `payment:update` to the `payment:<id>` / `user:<id>` rooms.

---

## 2. Database Design

Schema DDL with full rationale: `src/database/migrations/001-initial-schema.sql`.
TypeORM entities: `src/modules/{payments,outbox}/entities/`.

### `payments`
| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | server-generated |
| `client_request_id` | `uuid` UNIQUE | client idempotency key (create path) |
| `order_id` / `user_id` | `uuid` NOT NULL | |
| `amount` | `numeric(14,2)` NOT NULL | money — never `float` |
| `currency` | `varchar(3)` | ISO 4217 |
| `status` | `varchar(16)` | `PENDING/PROCESSING/SUCCESS/FAILED/CANCELLED` + `CHECK` |
| `gateway_transaction_id` | `varchar(64)` | set by webhook |
| `version` | `int` | optimistic-lock counter (auto-bumped) |
| `created_at` / `updated_at` | `timestamptz` | |

Indexes: `user_id`, `order_id`, `(user_id, status, created_at DESC)` — every
listed/get path keys off these.

### `payment_events` — append-only webhook ledger
| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `payment_id` | `uuid` FK → payments (CASCADE) | |
| `gateway_event_id` | `varchar(128)` | gateway’s own id |
| `event_type` | `varchar(64)` | `payment.processing/succeeded/failed/…` |
| `payload` | `jsonb` | full raw event |
| `processed_at` / `created_at` | `timestamptz` | |

**`UNIQUE(gateway_event_id)`** is *the* idempotency fence — the database rejects
a second insert, serial or concurrent. Index on `payment_id` for FK traversal.

### `outbox_events` — transactional event bus
| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `aggregate_type` / `aggregate_id` | `varchar` / `uuid` | `payment` |
| `event_type` | `varchar` | `payment.created/succeeded/…` |
| `payload` | `jsonb` | |
| `status` | `varchar` | `PENDING → PROCESSING → PUBLISHED \| FAILED` |
| `partition_key` | `varchar` | per-aggregate ordering |
| `attempts` / `last_error` / `available_after` | | retry/backoff/DLQ |
| `created_at` | `timestamptz` | |

Indexes: `(status, created_at)` for the dispatcher scan; `(aggregate_type,
aggregate_id, created_at)` for per-aggregate ordered replay.

---

## 3. API Design

All JSON. Errors: `{ message, code, ... }` with proper HTTP status.

### `POST /payments`
Request
```json
{
  "orderId": "8a1b…-uuid",
  "userId": "d9f2…-uuid",
  "amount": 1999.99,
  "currency": "USD",
  "clientRequestId": "c7e1…-uuid"          // optional, idempotency key
}
```
Response `201 Created`
```json
{
  "id": "5f0e…-uuid",
  "orderId": "8a1b…",
  "userId": "d9f2…",
  "amount": "1999.99",
  "currency": "USD",
  "status": "PENDING",
  "gatewayTransactionId": null,
  "createdAt": "2026-08-07T10:00:00.000Z",
  "updatedAt": "2026-08-07T10:00:00.000Z"
}
```
Retrying with the same `clientRequestId` returns `409 DUPLICATE_REQUEST`.

### `GET /payments/:id`
`200` with the same payment shape; `404` otherwise.

### `GET /payments?page=1&limit=20&status=SUCCESS&userId=…`
```json
{
  "items": [ { "...": "payment..." } ],
  "total": 137,
  "page": 1,
  "limit": 20
}
```

### `POST /webhooks/payment`
Signed by the gateway (`X-Signature`, `X-Timestamp` headers).
Request
```json
{
  "id": "evt_01HZXP…",
  "event_type": "payment.succeeded",
  "payment_id": "5f0e…-uuid",
  "transaction_id": "ch_3P…",
  "event_time": 1762516800000,
  "data": { "amount": 1999.99, "currency": "USD" }
}
```
Response `200` (always — a non-2xx makes gateways retry; duplicates are cheap)
```json
{ "received": true, "event_id": "evt_01HZXP…", "disposition": "accepted" }
```
`disposition` is one of `accepted | duplicate | ignored`.

---

## 4. Concurrency & Idempotency (two instances, same webhook, same instant)

**No Redis lock is used for correctness.** The database enforces it:

1. Both instances verify the signature independently.
2. Both `BEGIN` a transaction (`READ COMMITTED`) and issue
   `INSERT INTO payment_events (gateway_event_id, …) ON CONFLICT DO NOTHING`.
3. The first transaction inserts the row (1 row affected). The second blocks on
   the *uncommitted* unique-index entry until the first commits, then the insert
   matches the conflict and affects **0 rows**.
4. The transaction that affected 1 row is the **sole authoritative processor**:
   `SELECT … FOR UPDATE` on the payment (serializes *different* legit events for
   the same payment), state-machine gate, update status, insert outbox, COMMIT.
5. The loser sees 0 affected rows, returns `disposition: "duplicate"`, and does
   **not** mutate anything.

Why this beats a Redis lock: the lock and the state it protects would live on
two different systems, introducing a TOCTOU window between lock-acquire and
DB-write. The unique index and the payment row are **the same store**, so the
arbitration is exactly as durable as the state itself.

Verified by `test/concurrency/webhook-idempotency.conc-spec.ts` — 20 parallel
deliveries of one event produce exactly one `payment_events` row, one outbox
row, one `SUCCESS` transition, and 19 duplicates.

---

## 5. Transaction & Consistency

```sql
BEGIN;
  INSERT INTO payment_events (payment_id, gateway_event_id, event_type, payload)
  VALUES (...) ON CONFLICT (gateway_event_id) DO NOTHING;
  -- if 0 rows affected → duplicate → ROLLBACK → return 200 duplicate

  SELECT * FROM payments WHERE id = $1 FOR UPDATE;      -- pessimistic path
  -- state-machine check (terminal states never change)

  UPDATE payments SET status = 'SUCCESS',
         gateway_transaction_id = $2, version = version + 1
  WHERE id = $1;

  INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
  VALUES ('payment', $1, 'payment.succeeded', …);
COMMIT;
```

**Why partial updates are impossible:** all four writes execute in one
transaction. Postgres either commits them all or rolls them all back. A process
crash between statements rolls back the transaction on connection close.
Therefore you can never observe *event recorded but status not updated*,
*status updated but outbox row missing*, etc. The outbox row is the durable
"event happened" signal; the relay converts it to a Redis publish *after* the
commit — never before — so consumers only ever see committed state.

Failure scenarios handled:
- **Duplicate delivery** → `ON CONFLICT DO NOTHING`, 0 rows, `duplicate`.
- **Payment not found** (webhook raced the create) → rollback, `404`, gateway retries.
- **Out-of-order event for terminal payment** → event is ledgered, state untouched, `ignored`.
- **Gateway retry storm** → every retry is a cheap no-op insert attempt.
- **Relay crash after publish, before `PUBLISHED`** → at-least-once re-publish; idempotent downstream.

---

## 6. Redis Usage (only where it adds value)

| Concern | Redis role | Why Postgres alone isn't enough |
|---|---|---|
| **WS cross-instance broadcast** | socket.io pub/sub adapter (`@socket.io/redis-adapter`) + `payment.events` channel | Postgres cannot push to thousands of long-lived sockets. Postgres is the *durable event log*; Redis is the *fast fan-out fabric*. |
| **Outbox relay channel** | publish target for the relay | N instances need one shared channel; Redis pub/sub is the lowest-latency glue. |
| Optional read caching | `GET payments/:id` short TTL (120s) | Offload hot reads; stale-by-design (clients are told via WS anyway). `redis.ttlSeconds`. |
| Optional rate limiting | token bucket (ioredis) | atomic increments outside DB load. |

Postgres is **never** the bottleneck for fan-out, and Redis is **never** the
arbiter of financial state. TTL strategy: only ephemeral/cacheable data gets a
TTL (payment JSON snapshot); the durable ledger has none.

---

## 7. Real-Time Updates

- Client connects to `/socket.io` with a JWT (`auth: { token }`).
- Server authenticates, auto-joins `user:<id>`, and verifies ownership before
  letting a socket join `payment:<id>` (`payments.gateway.ts`).
- When the outbox relay publishes to `payment.events`, `RealtimeBroadcaster`
  (`realtime.broadcaster.ts`) feeds `PaymentsGateway.broadcast()`, which emits
  `payment:update` to the room(s).
- Because the gateway uses the **Redis pub/sub adapter**, an update that
  originated on instance #1 reaches clients connected to instance #5 too.
- A fresh subscription receives a `payment.snapshot` (current state) so the
  client can never miss a transition that happened before subscribing.

Example client event:
```json
{ "eventType": "payment.succeeded", "paymentId": "5f0e…", "status": "SUCCESS", "userId": "d9f2…" }
```

---

## 8. Project Structure

```
src/
  config/                environment → typed config (configuration.ts)
  common/
    correlation/         X-Correlation-Id middleware + pino child binding
    crypto/              webhook-signer (HMAC-SHA256, constant-time, replay window)
    errors/              domain/HTTP error map
    lifecycle/           graceful shutdown ordering
  database/
    typeorm-config.ts    pooled, statement-timeout'd DataSource factory
    migrations/          001-initial-schema.sql (+index/constraint rationale)
  infrastructure/
    redis/               global Redis client + RedisService (lock/cache/publish)
  modules/
    payments/            entity, DTOs, service, controller, reconciliation job
    webhooks/            signature guard, idempotent service, state machine
    outbox/              transactional outbox entity + lease-based relay
    realtime/            WS gateway, Redis pub/sub adapter, outbox broadcaster
    health/              liveness/readiness for the LB
  main.ts                bootstrap: raw-body capture, pipes, adapters
```

Why it scales for large teams: modules are **feature slices** (a team owns
`payments/` end-to-end); `infrastructure/` is swappable (redis → kafka later);
`common/` is shared building blocks; contracts live next to their consumers;
every module is independently testable and independently deployable.

---

## 9. Production Considerations

- **Config**: `@nestjs/config` + typed `configuration.ts`; no `process.env` in app code.
- **Validation**: `class-validator` + global `ValidationPipe` (whitelist, forbid unknown).
- **Logging**: `nestjs-pino`, structured JSON, redacted secrets, latency access logs.
- **Correlation IDs**: `X-Correlation-Id` generated/propagated per request (`correlation-id.middleware.ts`).
- **Health**: `/health/live` + `/health/ready` (DB + Redis probes) for LB drain.
- **Graceful shutdown**: `enableShutdownHooks`; relay stopped before pools close.
- **Retry / DLQ**: outbox relay uses exponential backoff (`available_after`) and dead-letters (`FAILED`) after N attempts; reconciliation job rescues stuck payments.
- **Metrics**: wire `@opentelemetry/sdk-node` / `prom-client`; instrument relay lag, duplicate rate, tx duration.
- **Security**: HMAC-SHA256 signature verification on the raw body with replay window; constant-time compare; JWT on WS handshake; no secrets in logs.

---

## 10. Debugging Guide

**Duplicate payment events** — check the unique index held:
```sql
SELECT gateway_event_id, count(*) FROM payment_events GROUP BY 1 HAVING count(*) > 1;
```
If >1, a data import bypassed the constraint — truncate the dupes. In logs look for
`Duplicate webhook <id> dropped` (expected) and alert on the *ratio* of duplicates.

**Incorrect payment status** — query the event ledger to find what the gateway actually sent:
```sql
SELECT event_type, processed_at, payload FROM payment_events
WHERE payment_id = $1 ORDER BY processed_at;
```
Cross-check with gateway dashboard; out-of-order terminal events are intentionally `ignored`.

**Concurrent update issues** — monitor `log_lock_waits=on` and look for lock timeouts on `payments`; verify `version` bumps (optimistic) or `FOR UPDATE` (pessimistic).

**Lost WS updates** — confirm Redis connectivity: `redis-cli ping`; confirm relay marks rows `PUBLISHED` (`SELECT status, count(*) FROM outbox_events GROUP BY 1`); confirm sockets joined rooms (`socket.io` admin UI / adapter cluster rooms).

**Redis outage** — non-fatal by design: HTTP stays up, outbox rows remain `PENDING`/`FAILED` and are re-published when Redis returns; WS degrades to single-instance.

**Database failover** — PgBouncer/Patroni moves the VIP; connection pool retries (`retryAttempts`); in-flight webhook transactions abort and the gateway retries → idempotency absorbs the rest.

**Payment stuck PROCESSING** — the reconciliation job (`PaymentReconcileJob`) re-queries the gateway for stale non-terminal payments; check its logs for `Reconciling stuck payment`.

**Outbox not published** — check `status='FAILED'` (dead-letter) and `last_error`; re-queue via the ops helper (`requeueDeadLettered`) or:
```sql
UPDATE outbox_events SET status='PENDING', attempts=0, available_after=null
WHERE status='FAILED' AND aggregate_type='payment';
```

---

## 11. Testing Strategy

| Layer | What | Where |
|---|---|---|
| Unit | signer, state machine, webhook decision logic | `test/unit/*.spec.ts` |
| Integration | HTTP → service with real/mocked DB | `test/integration/*.it-spec.ts` |
| Concurrency | 20 parallel identical webhooks | `test/concurrency/*.conc-spec.ts` |
| Idempotency | duplicate/terminal/not-found dispositions | `webhooks.service.spec.ts` |
| Failure injection | Redis down, DB down, relay crash | `failure-injection` suite |

Commands: `npm run test:unit`, `npm run test:integration`,
`npm run test:concurrency` (needs a real Postgres — set `POSTGRES_*`).

### Example concurrency test (real Postgres)
`test/concurrency/webhook-idempotency.conc-spec.ts` fires
`Promise.all(Array.from({length:20}, () => handleWebhook(payload)))` for the same
`gateway_event_id` and asserts:
- exactly **1** `accepted`, **19** `duplicate`;
- exactly **1** row in `payment_events`;
- exactly **1** outbox row;
- payment ends `SUCCESS`.

---

## 12. Key Code

- Entities: `src/modules/payments/entities/*`, `src/modules/outbox/entities/*`
- Create payment: `src/modules/payments/payments.service.ts#createPayment`
- Webhook handler + fence: `src/modules/webhooks/webhooks.service.ts#processInTransaction`
- Idempotent insert: `insertEventFenced` (`ON CONFLICT DO NOTHING`)
- State machine: `src/modules/webhooks/payment-state-machine.ts`
- Outbox relay: `src/modules/outbox/outbox.service.ts`
- Redis publish + lock: `src/infrastructure/redis/redis.service.ts`
- WS gateway: `src/modules/realtime/payments.gateway.ts`
- Redis pub/sub adapter: `src/modules/realtime/redis-io.adapter.ts`

---

## 13. Trade-offs

- **Postgres is the source of truth** because money state must be durable,
  ACID, and queryable. Redis/Rabbit are fast but lose data on restart by design.
- **Redis is not used for financial consistency** — a lock in Redis + state in
  Postgres creates a cross-system TOCTOU. Correctness lives in Postgres
  constraints; Redis only moves bytes.
- **Pessimistic vs optimistic:** pessimistic (`SELECT FOR UPDATE`) is the
  default — webhooks for one payment are rare and hot, so serializing them is
  cheap and avoids retry loops. Optimistic (`WHERE version = …`) is available
  (`LOCKING_STRATEGY=optimistic`) for read-mostly aggregates; the unique-event
  fence already prevents double-processing either way.
- **When to introduce Kafka/RabbitMQ:** at 10k+ events/sec Redis pub/sub becomes
  lossy and is hard to replay. Outbox → Kafka gives ordered, replayable,
  partitioned streams (one partition per `partition_key`), consumer-group
  scaling, and a durable DLQ — the outbox design makes this a one-line relay swap.
- **At 10k+ webhook/sec evolution:** keep Postgres as the system of record but
  move the *ledger* (`payment_events`) to partitioned/child tables, batch the
  relay (`BATCH_SIZE`), shard by `payment_id` hash, and replace the redis
  fan-out with a Kafka consumer group feeding WS gateways. The unique-event
  fence and outbox remain unchanged — the invariants are database-level, so they
  survive the scale-out.

---

## 14. Assumptions

- **A single payment gateway**, identified by shared-secret HMAC-SHA256 in
  `X-Signature` + `X-Timestamp`. If callbacks could be forged, these would be
  replaced by TLS mutual-auth / a KMS-signed JWT, but the webhook handler itself
  is unchanged.
- **Events carry the target state** (`payment.succeeded` → `SUCCESS`) rather than
  a generic `payment.updated`. If the gateway only sends a generic event, the
  target status must be derived at the adapter boundary before the handler.
- **Webhooks are the source for `gateway_transaction_id`**; the reconciliation
  job is the fallback for payments the gateway never notifies about.
- **Money is never imported or exported as a float**: `numeric(14,2)` in storage,
  strings on the wire. Amounts over 99,999,999.99 are rejected at the DTO.
- **Redis may be absent in dev** (`WEBSOCKET_ENABLED=false`): HTTP + outbox
  still work; only cross-instance websocket fan-out and caching degrade.
- **One payment is owned by one user**; a user may have many payments. The
  ownership check in the WS gateway assumes `userId` is stable/immutable.
- **Postgres is reachable with `SECONDS>statement timeout`** — webhooks rely on
  the DB for idempotency; a DB outage means the gateway retries until it returns.
- **The gateway retries idempotently** (non-2xx → retry, eventually duplicates);
  the service makes those retries zero-cost by design.

---

## Quick Start

```bash
cp .env.example .env          # set POSTGRES_* / REDIS_* / secrets
npm install
npm run build
# apply schema:
psql -U $POSTGRES_USER $POSTGRES_DB -f src/database/migrations/001-initial-schema.sql
npm run start:dev
```

Endpoints: `POST/GET /payments`, `GET /payments`, `POST /webhooks/payment`,
`GET /health/live|ready`. WS: connect with `auth:{token}` then
`payment:subscribe { paymentId }`.
