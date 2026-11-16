import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { WebhookSignatureGuard } from './webhook-signature.guard';
import {
  GatewayWebhookDto,
  WebhookResponseDto,
} from './dto/gateway-webhook.dto';

/**
 * Public endpoint, protected solely by HMAC signature verification.
 * Idempotency makes it safe for the gateway to retry endlessly.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('payment')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WebhookSignatureGuard)
  handle(@Body() dto: GatewayWebhookDto): Promise<WebhookResponseDto> {
    return this.webhooksService.handleWebhook(dto);
  }
}