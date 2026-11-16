import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { RedisService } from '../../infrastructure/redis/redis.service';

/**
 * Liveness vs readiness:
 *  - /health/live — process is up.
 *  - /health/ready — DB + Redis are reachable; load balancer routes traffic
 *    only to ready instances and drains them on failure.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly redis: RedisService,
  ) {}

  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.db.pingCheck('postgres', { timeout: 1500 }),
      async () => {
        const ok = await this.redis.ping();
        return { redis: ok ? { status: 'up' } : { status: 'down' } };
      },
    ]);
  }
}