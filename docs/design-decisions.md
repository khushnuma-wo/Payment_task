# Payment Service — Design Decisions

This document records the key design decisions, the reasons behind them, and
the trade-offs involved. The intent is to be descriptive rather than
prescriptive: each decision is stated together with what it solves, what it
costs, and when it should be revisited.

## 1. Stack

| Choice | Rationale |
|---|---|
| **Node.js + NestJS** | Provides structure (modules, DI, decorators, pipes, guards) which keeps the service maintainable and testable. |
| **PostgreSQL** | Provides ACID transactions, row locking, `ON CONFLICT`, CHECK constraints, and exact `numeric` types, which match the requirements of financial data. |
| **TypeORM** | Has first-class NestJS integration and supports both entity-driven schema and SQL migrations, plus pessimistic and optimistic locking. |
| **Redis** | Used for low-latency pub/sub across instances. It is treated as an auxiliary component rather than a store of record. |
| **Socket.IO** | Provides WebSocket rooms and namespaces, with a Redis adapter for multi-instance broadcasts. |

**Trade-off:** NestJS/TypeORM add abstraction and some runtime overhead compared
to plain Express + raw SQL; in exchange the codebase is more uniform and easier
to extend. If query performance became the bottleneck, the data layer could be
replaced with raw SQL while keeping the module boundaries.

## 2. Source of truth: PostgreSQL rather than Redis

Financial state is stored in PostgreSQL. Redis is in-memory and loses data on
restart, so it is not used to hold state that must survive process restarts.

**Consequence:** all consistency guarantees come from the database. Redis is used
for fan-out and transient data only, which keeps the correctness boundary in one
place.

## 3. Database design

### `payments` — the aggregate root
- `id uuid PK` — identity.
- `client_request_id uuid UNIQUE` — idempotency key supplied by the client at
  creation time.
- `amount numeric(14,2)` — money is stored as exact decimals, not floating point.
- `status varchar` with a `CHECK` constraint listing the legal values.
- `version int` — incremented on each update; used by the optimistic-locking path.
- Indexes on `user_id`, `order_id`, and `(user_id, status, created_at DESC)`
  cover the list/get query patterns.

### `payment_events` — append-only webhook ledger
- `gateway_event_id varchar UNIQUE` — used as the idempotency fence: the second
  insert for the same gateway event is rejected by the database, whether it
  arrives serially or concurrently.
- `payment_id uuid FK → payments ON DELETE CASCADE` — the ledger is tied to the
  payment's lifetime.
- `payload jsonb` — stores the raw webhook for audit and debugging.

### `outbox_events` — transactional event bus
- Written in the same transaction as the state change, so an event is only
  visible after the change is committed.
- `status` lifecycle `PENDING → PROCESSING → PUBLISHED | FAILED`, with
  `attempts`, `last_error`, and `available_after` for backoff and
  dead-lettering.
- Indexes on `(status, created_at)` (dispatcher scan) and
  `(aggregate_type, aggregate_id, created_at)` (ordered replay).

## 4. Concurrency (multiple instances, same webhook)

The approach relies on database constraints rather than a distributed lock.

When two instances receive the same webhook event concurrently:

1. Each verifies the signature independently.
2. Each runs `INSERT ... ON CONFLICT (gateway_event_id) DO NOTHING`.
3. Exactly one insert affects one row; the other blocks on the uncommitted
   unique index entry, then matches the conflict and affects zero rows.
4. The transaction that inserted the row takes `SELECT ... FOR UPDATE` on the
   payment (which serializes different legitimate events for the same payment),
   runs the state-machine check, updates the status, inserts the outbox row, and
   commits.
5. The other transaction returns `disposition: "duplicate"` and changes nothing.

**Why not a Redis lock:** a lock stored in Redis protecting state stored in
PostgreSQL leaves a window between lock acquisition and database write. Placing
the arbitration in the database keeps the guard and the state in the same
storage system.

The same principle is used for creation: `client_request_id` has a unique
constraint; a pre-check returns the existing payment, and a race that bypasses
the pre-check is resolved by the constraint, producing a `409`.

This behavior is covered by `test/concurrency/webhook-idempotency.conc-spec.ts`.

## 5. Transactions and consistency

Each mutation is executed in a single transaction:

```
BEGIN;
  INSERT INTO payment_events ... ON CONFLICT DO NOTHING;  -- idempotency fence
  SELECT ... FOR UPDATE;                                   -- serialize the payment
  UPDATE payments SET status = <target>, ...;
  INSERT INTO outbox_events ...;                           -- durable event record
COMMIT;
```

**Effect:** all four statements commit or roll back together. A failure part-way
through leaves no partial state (for example, a recorded event without a status
change). The outbox row is the durable signal that an event occurred; the relay
publishes to Redis only after the transaction commits.

**Trade-off:** a single transaction per webhook means webhooks for the same
payment are serialized. For the expected volume this is not a bottleneck; if it
became one, the unique-event fence could remain while the state transition is
moved to a queue worker with an explicit reconciliation step.

## 6. Why the outbox pattern

Publishing to Redis inside the webhook handler would couple the durability of
the event to the availability of Redis: the database commit could succeed while
the publish fails, or vice-versa. The outbox makes the event a committed row and
lets a relay convert it into a publish afterwards, with retries, backoff, and a
dead-letter state. It also separates the write path from the fan-out path.

## 7. Real-time updates across instances

- Clients connect over Socket.IO with a JWT; the gateway verifies it, adds the
  socket to the `user:<id>` room, and checks ownership before a socket can join
  `payment:<id>`.
- The outbox relay publishes to the Redis channel `payment.events`.
- `RealtimeBroadcaster` and the Redis pub/sub adapter deliver the message to
  every instance, so an update originating on one instance reaches clients
  connected to another.
- A fresh subscription receives a `payment.snapshot` with the current state, so
  a client that subscribes after a transition still observes the latest state.

**Trade-off:** Redis pub/sub is at-least-once and has no replay mechanism; a
message published while an instance is down is not retained. Because each
message is a state snapshot and clients receive a snapshot on subscribe, the
downstream effect is idempotent.

## 8. Pessimistic vs optimistic locking

Pessimistic locking (`SELECT ... FOR UPDATE`) is the default. Webhooks for one
payment are infrequent relative to total traffic, so serializing them is cheap
and avoids retry loops. Optimistic locking (`WHERE version = ...`) is available
via `LOCKING_STRATEGY=optimistic` for read-heavy workloads; the unique-event
fence prevents double-processing in either mode.

## 9. Failure handling

| Failure | Behavior |
|---|---|
| Duplicate webhook | `ON CONFLICT DO NOTHING` → `duplicate`, no state change |
| Webhook for unknown payment (raced create) | rollback → `404` → gateway retries |
| Out-of-order event for a terminal payment | event is recorded, state unchanged → `ignored` |
| Redis unavailable | HTTP remains available; outbox rows remain `PENDING` and are republished when Redis returns; websocket delivery is limited to the local instance |
| Database unavailable | gateway retries; idempotency handles duplicates when the database recovers |
| Relay failure during publish | retried with backoff; dead-lettered after N attempts |
| Payment stuck in `PROCESSING` | reconciliation job re-queries the gateway |

## 10. Scale-out

If throughput grows significantly, the invariants that matter (unique-event
fence, outbox) are database-level and do not change. Likely adjustments: partition
the ledger tables, increase relay batch size, and replace Redis fan-out with a
durable message bus feeding the websocket gateways. The outbox relay can switch
its transport without changing the write path.

## 11. Assumptions

- A single gateway, authenticated by shared-secret HMAC-SHA256 (`X-Signature`
  and `X-Timestamp`).
- Webhook events indicate the target state (for example `payment.succeeded`
  implies `SUCCESS`).
- Webhooks are the source of `gateway_transaction_id`; the reconciliation job
  handles payments the gateway does not notify about.
- Money is stored as `numeric(14,2)` and represented as a string on the wire.
- Redis may be absent in development (`WEBSOCKET_ENABLED=false`); only fan-out
  and caching degrade.
- The gateway retries webhooks after non-2xx responses; the service treats
  retries as expected and handles them at no cost.

## 12. Verification

| Layer | What is tested |
|---|---|
| Unit | signer, state machine, webhook decision logic |
| Integration | HTTP through to service with real/mocked database |
| Concurrency | 20 parallel deliveries of one event (real PostgreSQL) |
| Idempotency | duplicate / terminal / not-found dispositions |
| Manual E2E | `test/manual/all-apis.mjs`, `test/manual/e2e.mjs`, `test/manual/ws-realtime.mjs` |
