import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmptyObject,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { GATEWAY_WEBHOOK_TYPES } from '../../../common/constants/payment';

/**
 * The canonical gateway payload. The gateway signs the raw body; the DTO is
 * validated after signature verification.
 */
export class GatewayWebhookDto {
  @IsString()
  id: string;

  @IsIn(GATEWAY_WEBHOOK_TYPES)
  event_type: string;

  @IsUUID()
  payment_id: string;

  @IsOptional()
  @IsString()
  transaction_id?: string;

  /** Gateway-side event timestamp (ms epoch) — also used for replay checks. */
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  event_time?: number;

  @IsObject()
  @IsNotEmptyObject()
  data: Record<string, unknown>;
}

export class WebhookAckDto {
  /** The gateway event id we just handled. */
  event_id: string;
  /** True when this delivery was the first; false when it was a duplicate. */
  processed: boolean;
}

/** HTTP-facing response for the webhook endpoint. */
export class WebhookResponseDto {
  received: true;
  event_id: string;
  /** 'accepted' | 'duplicate' | 'ignored' */
  disposition: 'accepted' | 'duplicate' | 'ignored';
}