import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module, Injectable, Inject, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { OutboxEvent } from './src/modules/outbox/entities/outbox-event.entity';
import { RedisService } from './src/infrastructure/redis/redis.service';
import { redis } from './src/config/configuration';

const C = 'REDIS_CLIENT';
const cfg = { REDIS_HOST:'127.0.0.1', REDIS_PORT:'6379', REDIS_DB:'0', PORT:'3000', NODE_ENV:'development' };
for (const k in cfg) if (!(k in process.env)) process.env[k]=cfg[k];

@Module({
  providers: [
    { provide: C, useFactory: (c: ConfigService) => new Redis({ host: c.get('redis').host, port: c.get('redis').port, lazyConnect: true }), inject: [ConfigService] },
    RedisService,
  ],
  exports: [C, RedisService],
})
class RM {}

@Module({ imports: [RM, TypeOrmModule.forFeature([OutboxEntity])], providers: [{ provide: 'Outbox', useFactory: (r: RedisService) => ({r}), inject: [RedisService] }] })
class OutboxM {}

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true, load: [redis] }), RM, OutboxM], controllers: [] })
class App {}

NestFactory.createApplicationContext(App).then(() => console.log('BOOT OK')).catch((e) => console.log('BOOT FAIL =>', e.message.split('\n')[0]));
