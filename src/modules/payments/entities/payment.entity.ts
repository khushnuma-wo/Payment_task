import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

export enum PaymentStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

/**
 * A single payment. The status field is authoritative; clients are never
 * told a state that was not committed here atomically with the corresponding
 * payment_event.
 */
@Entity('payments')
export class Payment {
  /** Optional idempotency key supplied by the client at creation time. */
  @Column({ name: 'client_request_id', type: 'uuid', nullable: true })
  clientRequestId?: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount: string;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ type: 'varchar', length: 16 })
  status: PaymentStatus;

  @Column({ name: 'gateway_transaction_id', type: 'varchar', length: 64, nullable: true })
  gatewayTransactionId?: string | null;

  @PrimaryColumn({ type: 'uuid' })
  id: string;

  /**
   * Optimistic-locking version. Bumped automatically by TypeORM on update;
   * used by the optimistic-concurrency path of the webhook handler.
   */
  @VersionColumn()
  version: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

export const PAYMENT_STATUSES: PaymentStatus[] = Object.values(PaymentStatus);