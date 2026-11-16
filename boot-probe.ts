import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module, Injectable, Inject } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
const C = 'REDIS_CLIENT';

@Injectable()
class Svc {
  constructor(@Inject(C) private c: unknown, private cfg: ConfigService) {}
}

@Module({
  providers: [
    { provide: C, useFactory: (c: ConfigService) => new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: true }), inject: [ConfigService] },
    Svc,
  ],
  exports: [C, Svc],
})
class RM {}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), RM],
})
class App {}

NestFactory.createApplicationContext(App).then(() => console.log('BOOT OK')).catch((e) => console.log('BOOT FAIL', e.message.split('\n')[0]));
