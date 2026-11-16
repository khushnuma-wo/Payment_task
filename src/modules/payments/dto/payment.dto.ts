import { Expose, plainToInstance } from 'class-transformer';
import { Payment, PaymentStatus } from '../entities/payment.entity';

export class PaymentResponseDto {
  @Expose() id: string;
  @Expose() orderId: string;
  @Expose() userId: string;
  @Expose() amount: string;
  @Expose() currency: string;
  @Expose() status: PaymentStatus;
  @Expose() gatewayTransactionId?: string | null;
  @Expose() createdAt: Date;
  @Expose() updatedAt: Date;

  static from(entity: Payment): PaymentResponseDto {
    return plainToInstance(PaymentResponseDto, entity, {
      excludeExtraneousValues: true,
    });
  }
}

export class PaymentListResponseDto {
  items: PaymentResponseDto[];
  total: number;
  page: number;
  limit: number;
}