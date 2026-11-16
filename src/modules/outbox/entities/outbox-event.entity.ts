import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum OutboxStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  PUBLISHED = 'PUBLISHED',
  FAILED = 'FAILED',
}

/**
 * Transactional Outbox.
 * Events are written here in the SAME transaction that mutates business
 * state (payment.status). A relay worker publishes them to Redis Pub/Sub /
 * a topic and marks published_at. Postgres acts as the durable queue.
 */
@Entity('outbox_events')
@Index('idx_outbox_events_aggregate', ['aggregateType', 'aggregateId'])
@Index('idx_outbox_events_pending', ['status', 'createdAt'])
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** e.g. 'payment' */
  @Column({ name: 'aggregate_type', type: 'varchar', length: 64 })
  aggregateType: string;

  @Column({ name: 'aggregate_id', type: 'uuid' })
  aggregateId: string;

  /** e.g. 'payment.completed' */
  @Column({ name: 'event_type', type: 'varchar', length: 128 })
  eventType: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ name: 'status', type: 'varchar', length: 16, default: OutboxStatus.PENDING })
  status: OutboxStatus;

  /** Partition/ordering key for the dispatcher so per-aggregate ordering holds. */
  @Column({ name: 'partition_key', type: 'varchar', length: 128, nullable: true })
  partitionKey?: string | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt?: Date | null;

  /** Delivery attempts; a dead-letter threshold abandons the event. */
  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null;

  @Column({ name: 'available_after', type: 'timestamptz', nullable: true })
  availableAfter?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}