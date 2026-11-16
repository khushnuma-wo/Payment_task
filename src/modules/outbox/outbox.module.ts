import { Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxEvent } from './entities/outbox-event.entity';
import { OutboxService } from './outbox.service';
import { RedisModule } from '../../infrastructure/redis/redis.module';

@Module({
  imports: [RedisModule, TypeOrmModule.forFeature([OutboxEvent])],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly outbox: OutboxService) {}

  onModuleInit(): void {
    this.outbox.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.outbox.stop();
  }
}