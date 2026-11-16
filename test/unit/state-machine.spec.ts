import { PaymentStatus } from '../../src/modules/payments/entities/payment.entity';
import { canTransition, TERMINAL_STATUSES } from '../../src/modules/webhooks/payment-state-machine';

describe('payment state machine', () => {
  it('allows forward progress from PENDING', () => {
    for (const to of [PaymentStatus.PROCESSING, PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.CANCELLED]) {
      expect(canTransition(PaymentStatus.PENDING, to)).toBe(true);
    }
  });

  it('allows PROCESSING -> SUCCESS/FAILED/CANCELLED', () => {
    expect(canTransition(PaymentStatus.PROCESSING, PaymentStatus.SUCCESS)).toBe(true);
    expect(canTransition(PaymentStatus.PROCESSING, PaymentStatus.FAILED)).toBe(true);
    expect(canTransition(PaymentStatus.PROCESSING, PaymentStatus.CANCELLED)).toBe(true);
  });

  it('never mutates terminal states', () => {
    for (const terminal of TERMINAL_STATUSES) {
      for (const to of Object.values(PaymentStatus)) {
        expect(canTransition(terminal as PaymentStatus, to)).toBe(false);
      }
    }
  });

  it('rejects backwards transitions', () => {
    expect(canTransition(PaymentStatus.SUCCESS, PaymentStatus.PROCESSING)).toBe(false);
    expect(canTransition(PaymentStatus.FAILED, PaymentStatus.PENDING)).toBe(false);
  });
});
