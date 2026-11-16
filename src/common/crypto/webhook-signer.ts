import { createHmac, timingSafeEqual } from 'crypto';

/**
 * HMAC-SHA256 signature verification for inbound gateway webhooks.
 *
 * Protocol: the gateway sends headers `X-Signature` and `X-Timestamp`.
 *   signature = HMAC_SHA256(WEBHOOK_SECRET, `${timestamp}.${rawBody}`)
 * The raw, unmodified request body must be used, hence the raw-body
 * middleware in main.ts.
 */
export class WebhookSigner {
  constructor(private readonly secret: string) {}

  /**
   * Verify a gateway signature. Constant-time, with replay window.
   */
  verify(timestamp: string, rawBody: string, provided: string): boolean {
    if (!timestamp || typeof rawBody !== 'string' || !provided) return false;

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;

    // Replay-protection window: +-5 minutes. Tolerates small clock skew.
    const ageMs = Date.now() - ts;
    if (ageMs < -60_000 || ageMs > 300_000) return false;

    const expected = this.#signTimestamp(timestamp, rawBody);
    return this.#safeEqual(expected, provided);
  }

  /** Compute signature for a known timestamp+body (used in tests). */
  sign(timestamp: string, rawBody: string): string {
    return this.#signTimestamp(timestamp, rawBody);
  }

  #signTimestamp(timestamp: string, rawBody: string): string {
    return createHmac('sha256', this.secret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
  }

  #safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }
}