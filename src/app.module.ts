import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import { configuration } from './config/configuration';
import { buildTypeOrmOptions } from './database/typeorm-config';
import { PaymentsModule } from './modules/payments/payments.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { HealthModule } from './modules/health/health.module';
import { CorrelationIdMiddleware } from './common/correlation/correlation-id.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        // Redact secrets from structured logs.
        redact: {
          paths: ['req.headers.authorization', 'req.headers["x-signature"]'],
          censor: '[REDACTED]',
        },
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
      },
    }),
    // Injected config-driven TypeORM setup (config comes from ConfigModule above).
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => buildTypeOrmOptions(c.get('postgres')!),
    }),
    PaymentsModule,
    WebhooksModule,
    OutboxModule,
    RealtimeModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}