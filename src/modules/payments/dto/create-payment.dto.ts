import {
  IsNumber,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class CreatePaymentDto {
  @IsUUID()
  orderId: string;

  @IsUUID()
  userId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99_999_999.99)
  amount: number;

  /** ISO 4217 currency code (e.g. USD, EUR). */
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code (e.g. USD)' })
  currency: string;

  /** Client-supplied idempotency key — retrying the same creates returns the same payment. */
  @IsUUID()
  @IsOptional()
  clientRequestId?: string;
}