import { randomUUID } from 'crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { NextFunction, Request, Response } from 'express';

declare module 'express' {
  interface Request {
    correlationId?: string;
    rawBody?: string;
  }
}

/**
 * Generates / propagates a correlation id (X-Correlation-Id) and binds it to
 * the pino logger child so the whole request lifecycle shares one id in logs,
 * metrics, and (forwarded) downstream APIs.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  constructor(private readonly logger: PinoLogger) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-correlation-id'];
    const correlationId = Array.isArray(incoming)
      ? incoming[0]
      : (incoming as string) ?? randomUUID();

    req.correlationId = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);
    // Re-bind logger for this request.
    (this.logger.logger as any).child({ correlationId });

    next();
  }
}