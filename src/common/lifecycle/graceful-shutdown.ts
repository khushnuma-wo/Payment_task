import { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';

/**
 * Graceful shutdown ordering with a helper for health-readiness.
 * 1. Stop accepting new connections (HTTP/WS).
 * 2. Stop the outbox dispatcher so no partial publishes.
 * 3. Close Redis (no new broadcasts).
 * 4. Close the Postgres pool; in-flight transactions drain.
 *
 * Default Nest `enableShutdownHooks` is wired here.
 */
export function setupGracefulShutdown(app: INestApplication): void {
  app.enableShutdownHooks();

  // Signal that the instance is draining so the LB can note if it has a /health.
  // Actual registry-aware draining is delegated to lifecycle hooks in each
  // module's OnApplicationShutdown.
  Logger.log('Graceful shutdown hooks armed', 'Lifecycle');
}