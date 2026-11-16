import { Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Provides a single shared RedisService (owns its own client internally).
 * Used for:
 *  - socket.io pub/sub adapter (cross-instance broadcast)
 *  - outbox event publish channel
 *  - optional rate limiting
 *  - optional short-lived payment read cache
 *
 * It is NOT used for payment state — Postgres remains the source of truth.
 * Import this module wherever RedisService is needed.
 */
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}