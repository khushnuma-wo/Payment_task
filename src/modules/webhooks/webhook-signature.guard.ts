import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { WebhookSigner } from '../../common/crypto/webhook-signer';
import { InvalidWebhookSignatureError } from '../../common/errors/payment-errors';

/**
 * Verifies the HMAC-SHA256 signature on every webhook before it touches the
 * handler. Runs on the raw body captured by the express json() middleware.
 */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WebhookSignatureGuard.name);
  private readonly signer: WebhookSigner;

  constructor(config: ConfigService) {
    this.signer = new WebhookSigner(config.get<string>('webhook.secret')!);
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const signature = req.headers['x-signature'] as string | undefined;
    const timestamp = req.headers['x-timestamp'] as string | undefined;

    const body = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body);

    if (!this.signer.verify(timestamp ?? '', body, signature ?? '')) {
      this.logger.warn(
        `Rejected webhook with bad signature (ts=${timestamp ?? 'none'})`,
      );
      throw new InvalidWebhookSignatureError();
    }
    return true;
  }
}