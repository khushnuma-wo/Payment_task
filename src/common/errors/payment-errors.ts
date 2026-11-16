import { HttpException, HttpStatus } from '@nestjs/common';

/** Business rule violations that map to non-500 responses. */

export class PaymentNotFoundError extends HttpException {
  constructor(id: string) {
    super({ message: `Payment ${id} not found`, code: 'PAYMENT_NOT_FOUND' }, HttpStatus.NOT_FOUND);
  }
}

export class DuplicateClientRequestError extends HttpException {
  constructor() {
    super(
      { message: 'A payment for this client_request_id already exists', code: 'DUPLICATE_REQUEST' },
      HttpStatus.CONFLICT,
    );
  }
}

export class InvalidWebhookSignatureError extends HttpException {
  constructor() {
    super(
      { message: 'Invalid webhook signature', code: 'BAD_SIGNATURE' },
      HttpStatus.UNAUTHORIZED,
    );
  }
}

export class InvalidTransitionError extends HttpException {
  constructor(from: string, to: string) {
    super(
      {
        message: `Illegal payment transition ${from} -> ${to}`,
        code: 'INVALID_TRANSITION',
        from,
        to,
      },
      HttpStatus.CONFLICT,
    );
  }
}

/** Internal state-machine guard, independent of HTTP. */
export class InvalidTransitionDomainError extends Error {
  constructor(from: string, to: string) {
    super(`Illegal payment transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionDomainError';
  }
}

/** Raised when specified for outbox, not an HTTP concern. */
export class NotImplementedHttp extends HttpException {
  constructor(msg = 'Not yet implemented') {
    super({ message: msg, code: 'NOT_IMPLEMENTED' }, HttpStatus.NOT_IMPLEMENTED);
  }
}