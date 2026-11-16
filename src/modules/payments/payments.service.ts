import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Payment, PaymentStatus } from './entities/payment.entity';
import { OutboxEvent, OutboxStatus } from '../outbox/entities/outbox-event.entity';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ListPaymentsDto } from './dto/list-payments.dto';
import { PaymentResponseDto } from './dto/payment.dto';
import { PaymentEventType } from '../../common/constants/payment';
import { RedisService } from '../../infrastructure/redis/redis.service';
import {
  DuplicateClientRequestError,
  PaymentNotFoundError,
} from '../../common/errors/payment-errors';

const cacheKey = (id: string): string => `payment:cache:${id}`;

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Payments: query path. All state mutations happen via the webhook handler
 * (gateway-driven); creation is the only client-initiated write.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  private readonly cacheTtlSeconds: number;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.cacheTtlSeconds = config.get<number>('redis.ttlSeconds') ?? 120;
  }

  /**
   * Create a payment and its outbox 'payment.created' event atomically.
   * Idempotent on client_request_id: a retry must not double-charge or double-create.
   */
  async createPayment(dto: CreatePaymentDto): Promise<PaymentResponseDto> {
    const id = randomUUID();
    try {
      const payment = await this.dataSource.transaction(async (manager) => {
        if (dto.clientRequestId) {
          const existing = await manager.findOne(Payment, {
            where: { clientRequestId: dto.clientRequestId },
          });
          if (existing) {
            throw new DuplicateClientRequestError();
          }
        }

        const p = manager.create(Payment, {
          id,
          orderId: dto.orderId,
          userId: dto.userId,
          amount: dto.amount.toFixed(2),
          currency: dto.currency,
          status: PaymentStatus.PENDING,
          version: 1,
          clientRequestId: dto.clientRequestId,
        });
        await manager.save(p);

        await manager.save(
          manager.create(OutboxEvent, {
            aggregateType: 'payment',
            aggregateId: p.id,
            eventType: PaymentEventType.PAYMENT_CREATED,
            payload: {
              id: p.id,
              orderId: p.orderId,
              userId: p.userId,
              amount: p.amount,
              currency: p.currency,
              status: PaymentStatus.PENDING,
            },
            status: OutboxStatus.PENDING,
          }),
        );
        return p;
      });

    this.logger.log(`Created payment ${payment.id} for order ${payment.orderId}`);
    return PaymentResponseDto.from(payment);
  } catch (err) {
    // Two creates with the same client_request_id that race past the pre-check
    // are arbitrated by the DB: the loser hits the UNIQUE(client_request_id)
    // violation and is reported as a duplicate, not a 500.
    if ((err as any)?.code === '23505' && dto.clientRequestId) {
      throw new DuplicateClientRequestError();
    }
    throw err;
  }
}

  /**
   * Cache-aside read: Postgres remains authoritative, Redis only shortens the
   * hot-read path. A TTL (not invalidation-on-write) bounds staleness, which is
   * acceptable because clients are told of status changes over the websocket
   * independently of this cache.
   */
  async getPayment(id: string): Promise<PaymentResponseDto> {
    const cached = await this.redis.get(cacheKey(id));
    if (cached) {
      return JSON.parse(cached) as PaymentResponseDto;
    }

    const p = await this.paymentRepo.findOne({ where: { id } });
    if (!p) throw new PaymentNotFoundError(id);

    const dto = PaymentResponseDto.from(p);
    await this.redis.setEx(cacheKey(id), this.cacheTtlSeconds, JSON.stringify(dto));
    return dto;
  }

  async listPayments(query: ListPaymentsDto): Promise<Paginated<PaymentResponseDto>> {
    const { page, limit, status, userId } = query;
    const qb = this.paymentRepo.createQueryBuilder('p');
    if (status) qb.andWhere('p.status = :status', { status });
    if (userId) qb.andWhere('p.userId = :userId', { userId });
    qb.orderBy('p.createdAt', 'DESC');

    const [rows, total] = await Promise.all([
      qb.clone().skip((page - 1) * limit).take(limit).getMany(),
      qb.clone().getCount(),
    ]);

    return {
      items: rows.map((r) => PaymentResponseDto.from(r)),
      total,
      page,
      limit,
    };
  }
}

// Keep EntityManager import referenced for downstream guarded manual tx usage.
export type TxManager = EntityManager;