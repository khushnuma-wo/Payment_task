import { Injectable, Inject, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { In, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Payment, PaymentStatus } from './entities/payment.entity';

/** Implemented by the gateway-integration layer to fetch authoritative state. */
export interface PaymentStatusReconciler {
  requestStatusFromGateway(payment: Payment): Promise<void>;
}

export const PAYMENT_RECONCILER = 'PaymentStatusReconciler';

/**
 * Recovery for payments stuck in PROCESSING (a webhook was lost or dropped).
 * On a schedule it re-queries the gateway for the authoritative state. Any
 * terminal status returned still flows through the normal idempotent webhook
 * path so the state machine and outbox reuse the same guarantees.
 */
@Injectable()
export class PaymentReconcileJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentReconcileJob.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    @Inject(PAYMENT_RECONCILER)
    private readonly reconciler: PaymentStatusReconciler,
    @InjectRepository(Payment) private readonly repo: Repository<Payment>,
  ) {}

  async onModuleInit(): Promise<void> {
    const scanMs = this.config.get<number>('jobs.stuckPaymentScanMs') ?? 60000;
    this.timer = setInterval(() => void this.run(), scanMs);
    this.timer.unref();
    void this.run();
  }

  async run(): Promise<void> {
    const maxAgeMs =
      this.config.get<number>('jobs.stuckPaymentMaxAgeMs') ?? 300_000;
    const cutoff = new Date(Date.now() - maxAgeMs);

    const stale = await this.repo.find({
      where: {
        status: In([PaymentStatus.PENDING, PaymentStatus.PROCESSING]),
      },
      take: 200,
    });

    for (const p of stale) {
      if (p.updatedAt.getTime() > cutoff.getTime()) continue; // still in-window
      this.logger.warn(`Reconciling stuck payment ${p.id} (${p.status})`);
      try {
        await this.reconciler.requestStatusFromGateway(p);
      } catch (e) {
        this.logger.warn(`reconcile failed for ${p.id}: ${(e as Error).message}`);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }
}