import { PaymentStatus } from '../payments/entities/payment.entity';

/**
 * Payment state machine.
 * PENDING/PROCESSING can move onward; terminal states (SUCCESS/FAILED/CANCELLED)
 * are immutable — late or out-of-order gateway events are recorded to the event
 * ledger but never mutate a terminal payment.
 */
const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  [PaymentStatus.PENDING]: [
    PaymentStatus.PROCESSING,
    PaymentStatus.SUCCESS,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
  ],
  [PaymentStatus.PROCESSING]: [
    PaymentStatus.SUCCESS,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
  ],
  [PaymentStatus.SUCCESS]: [],
  [PaymentStatus.FAILED]: [],
  [PaymentStatus.CANCELLED]: [],
};

export function canTransition(
  from: PaymentStatus,
  to: PaymentStatus,
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export const TERMINAL_STATUSES = [
  PaymentStatus.SUCCESS,
  PaymentStatus.FAILED,
  PaymentStatus.CANCELLED,
] as const;