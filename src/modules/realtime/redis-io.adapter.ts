import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { ConfigService } from '@nestjs/config';
import { HttpServer } from '@nestjs/common';
import { INestApplicationContext } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Swaps socket.io's in-memory adapter for the Redis pub/sub adapter.
 * With the default adapter, a broadcast only reaches sockets on the SAME
 * instance; the Redis adapter fans a published event out to every backend
 * instance, so clients get updates regardless of which instance the outbox
 * relay (or a gateway redirect) happened to run on.
 */
export class RedisIoAdapter extends IoAdapter {
  private adapter?: ReturnType<typeof createAdapter>;

  constructor(
    appOrHttpServer: INestApplicationContext | HttpServer,
    private readonly config: ConfigService,
  ) {
    super(appOrHttpServer);
  }

  /** Bind the Redis pub/sub clients and attach the cluster adapter. */
  async connectToRedis(): Promise<void> {
    const cfg = this.config.get('redis');

    const pubClient = new Redis({ host: cfg.host, port: cfg.port, db: cfg.db });
    const subClient = pubClient.duplicate();

    this.adapter = createAdapter(pubClient, subClient, {
      requestsTimeout: 10_000,
    });
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    if (this.adapter) server.adapter(this.adapter);
    return server;
  }
}