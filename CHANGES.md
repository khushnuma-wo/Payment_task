# Notes on completing this task

I was given this project partially built, so most of the core design
(schema, outbox pattern, webhook idempotency, state machine, Socket.IO +
Redis real-time layer) was already there. My job was to get it actually
working correctly, which meant running it for real against Postgres and
Redis instead of just reading through the code — that's how most of the
bugs below turned up.

## Bugs I found and fixed

**Outbox relay was using the wrong column name.** The relay's claim query
referenced `availableAfter` in a raw SQL string, but the real Postgres
column is `available_after`. Would've thrown on every relay tick against a
real DB, which means the outbox relay (and real-time updates with it) would
never have actually run. No test caught it because none of them hit a real
database.

**Correlation-ID middleware was crashing the server.** It called
`res.setHeader()` inside a `res.on('finish', ...)` callback, which throws
`ERR_HTTP_HEADERS_SENT` since headers are already sent by that point. The
middleware wasn't even wired into the app originally, so this was dormant
until I wired it up — then every single request killed the process.
Deleted the broken block.

**App crashed whenever Redis was down.** Two of the ioredis clients
(socket.io's Redis adapter, and the outbox broadcaster's subscriber) had no
`error` listener. Once ioredis ran out of retries, it rejected an internal
promise nothing was catching, and Node kills the process on an unhandled
rejection by default. So the whole "Redis going down shouldn't take the
service down" story in the docs wasn't actually true. Added the missing
error handlers and a global unhandled-rejection guard in `main.ts`.

**The concurrency test's own setup was broken.** It used
`synchronize: true` to build the schema, which makes TypeORM generate
`uuid_generate_v4()` defaults — needs the `uuid-ossp` extension, which the
test never created. Against a real fresh Postgres this fails, and gets
swallowed into a "Postgres unreachable, skipping" message that's actually
wrong — Postgres was reachable, the setup was just broken. Switched it to
run off the real migration file instead.

**Test scripts were misconfigured.** `npm run test:unit` was also
accidentally picking up the integration and concurrency spec files because
of a loose regex. And plain `npm test` used bare `jest` with no ts-jest
config, so it couldn't even parse TypeScript. Fixed both.

**Deleted some leftover debug files** (`boot-probe.ts`, `boot-probe2.ts`,
`tsconfig.probe.json`) that weren't part of the actual app.

## What I added

- A real Redis cache for `GET /payments/:id` — it was documented as a
  Redis use case but never actually implemented.
- A proper image diagram (`docs/architecture-diagram.svg`) instead of the
  ASCII one.

## How I checked all of this actually works

Ran the full automated suite (`test:unit`, `test:integration`,
`test:concurrency`) against a real local Postgres — the concurrency test
specifically fires 20 identical webhook deliveries at once and checks you
get exactly 1 `accepted` and 19 `duplicate`. Then started the real server
against real Postgres and real Redis and manually ran through the full
flow: create a payment, read it back, list it, send a signed webhook,
resend the same webhook (duplicate, correctly rejected), bad signature
(401), unknown ID (404). Also connected an actual WebSocket client and
confirmed the real-time `payment:update` push arrives after a webhook
comes in, and separately confirmed the server stays up and degrades
gracefully with Redis stopped.
