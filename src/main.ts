import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe, Logger } from '@nestjs/common';
import { json } from 'express';
import { Logger as PinoLogger, LoggerErrorInterceptor } from 'nestjs-pino';
import { AppModule } from './app.module';
import { setupGracefulShutdown } from './common/lifecycle/graceful-shutdown';
import { RedisIoAdapter } from './modules/realtime/redis-io.adapter';

// Third-party clients (ioredis, the socket.io Redis adapter) reject internal
// command promises when a connection's retry budget is exhausted. Node treats
// an unhandled rejection as fatal by default, which would undermine the
// documented "Redis down is non-fatal" guarantee the rest of the app relies
// on. Log and continue instead of crashing the process.
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  Logger.warn(`Unhandled promise rejection (non-fatal): ${message}`, 'Bootstrap');
});

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true, // let pino from the first log line
  });
  app.useLogger(app.get(PinoLogger));

  const config = app.get(ConfigService);

  // Raw body + signature. Express's `json()` is consumed first with
  // verify to capture rawBody for HMAC verification.
  app.use(
    json({
      limit: '256kb',
      verify: (req: any, _res: any, buf: Buffer) => {
        req.rawBody = buf.toString('utf8');
      },
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalInterceptors(new LoggerErrorInterceptor());

  // Cluster-aware websocket adapter (Redis pub/sub). Non-fatal if Redis is down:
  // the gateway still runs, but intra-instance broadcasts become single-node.
  if (config.get<boolean>('features.websocketEnabled')) {
    const redisAdapter = new RedisIoAdapter(app, config);
    await redisAdapter.connectToRedis().catch(() => {
      Logger.warn('Redis adapter unavailable; running single-node WS', 'Bootstrap');
    });
    app.useWebSocketAdapter(redisAdapter);
  }

  // Durable, well-tested graceful shutdown ordering.
  setupGracefulShutdown(app);

  const port = config.get<number>('app.port') ?? 3000;
  await app.listen(port);
  Logger.log(`Payment service listening on :${port}`, 'Bootstrap');
}
void bootstrap();