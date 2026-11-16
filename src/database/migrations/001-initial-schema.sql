/**
 * Bootstrap schema for the payment service (PostgreSQL 14+).
 *
 * Design rationale is inline as comments. The key correctness mechanism is the
 * UNIQUE constraint on payment_events.gateway_event_id: it is the database-level
 * fence that makes webhook delivery idempotent even under true concurrency.
 */
-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
    id                          UUID PRIMARY KEY,
    client_request_id           UUID UNIQUE,              -- client idempotency key
    order_id                    UUID NOT NULL,
    user_id                     UUID NOT NULL,
    amount                      NUMERIC(14, 2) NOT NULL,
    currency                    VARCHAR(3) NOT NULL,
    status                      VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    gateway_transaction_id      VARCHAR(64),
    version                     INTEGER NOT NULL DEFAULT 1, -- optimistic-lock counter
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_status CHECK (status IN ('PENDING','PROCESSING','SUCCESS','FAILED','CANCELLED')),
    CONSTRAINT chk_amount_positive CHECK (amount >= 0)
);

-- Queries always fetch by user_id or id.
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments (order_id);
-- List endpoint filters by status; combined with created_at for pagination.
CREATE INDEX IF NOT EXISTS idx_payments_user_status
    ON payments (user_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- payment_events      -- append-only ledger of gateway webhooks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_events (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id         UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    gateway_event_id   VARCHAR(128) NOT NULL,        -- gateway's own event id
    event_type         VARCHAR(64) NOT NULL,
    payload            JSONB NOT NULL,
    processed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- *THE* idempotency mechanism. Duplicate deliveries (serial or concurrent)
-- are rejected by the database when a second row is inserted.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_events_gateway_event_id
    ON payment_events (gateway_event_id);
-- Foreign-key traversal when attaching events to a payment.
CREATE INDEX IF NOT EXISTS idx_payment_events_payment_id
    ON payment_events (payment_id);

-- ---------------------------------------------------------------------------
-- outbox_events       -- transactional event bus envelope table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox_events (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(64) NOT NULL,
    aggregate_id   UUID NOT NULL,
    event_type     VARCHAR(128) NOT NULL,
    payload        JSONB NOT NULL,
    status         VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    partition_key  VARCHAR(128),
    published_at   TIMESTAMPTZ,
    attempts       INTEGER NOT NULL DEFAULT 0,
    last_error     TEXT,
    available_after TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dispatcher fan-out: find PENDING rows fast.
CREATE INDEX IF NOT EXISTS idx_outbox_events_pending
    ON outbox_events (status, created_at);
-- Per-aggregate ordering during dispatch.
CREATE INDEX IF NOT EXISTS idx_outbox_events_aggregate
    ON outbox_events (aggregate_type, aggregate_id, created_at);