import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Thin, injectable wrapper over ioredis with helpers we actually use.
 * Failures are logged but never throw into request paths — Redis sits off the
 * critical path. Callers decide how to degrade (e.g. skip caching).
 */
@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(config: ConfigService) {
    const cfg = config.get('redis');
    this.client = new Redis({
      host: cfg.host,
      port: cfg.port,
      db: cfg.db,
      lazyConnect: true,
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 100, 3000),
    });
    this.client.on('error', (err) => {
      // Non-fatal: Redis is optional infrastructure.
      this.logger.warn(`Redis error (non-fatal): ${err.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      if (this.client.status === 'wait') {
        await this.client.connect();
      }
    } catch (err) {
      this.logger.warn(`Redis connect failed (non-fatal): ${(err as Error).message}`);
    }
  }

  /** Atomic get-along-with-TTL; returns null when absent. */
  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (err) {
      this.logger.warn(`get failed: ${(err as Error).message}`);
      return null;
    }
  }

  async setEx(key: string, ttlSeconds: number, value: string): Promise<void> {
    try {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn(`setEx failed: ${(err as Error).message}`);
    }
  }

  async publish(channel: string, message: string): Promise<void> {
    try {
      await this.client.publish(channel, message);
    } catch (err) {
      // Reliability path: outbox dispatcher marks this event FAILED so it
      // can be retried — the message is not lost.
      this.logger.error(`publish failed on ${channel}: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Acquire a short-lived distributed lock with auto-expiry. Returns token on success. */
  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ok = await this.client.set(key, token, 'PX', ttlMs, 'NX');
    return ok === 'OK' ? token : null;
  }

  /** Release only if we still hold the token (keeps leases safe). */
  async releaseLock(key: string, token: string): Promise<void> {
    // Lua for atomic compare-and-delete.
    const script = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
    await this.client.eval(script, 1, key, token);
  }

  /** Health probe. */
  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}