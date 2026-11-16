import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Payment } from './payment.entity';

/**
 * Every raw webhook event delivered by the gateway.
 * The UNIQUE constraint on gateway_event_id is the *idempotency fence*:
 * PostgreSQL will reject the second of two concurrent inserts for the same
 * event, guaranteeing only one row exists per gateway event.
 */
@Entity('payment_events')
@Index('uq_payment_events_gateway_event_id', ['gatewayEventId'], { unique: true })
@Index('idx_payment_events_payment_id', ['paymentId'])
export class PaymentEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'payment_id', type: 'uuid' })
  paymentId: string;

  @Column({ name: 'gateway_event_id', type: 'varchar', length: 128 })
  gatewayEventId: string;

  /** e.g. 'payment.processing' / 'payment.succeeded'. */
  @Column({ name: 'event_type', type: 'varchar', length: 64 })
  eventType: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ name: 'processed_at', type: 'timestamptz', default: () => 'now()' })
  processedAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => Payment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'payment_id' })
  payment?: Payment;
}