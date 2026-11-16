import { WebhookSigner } from '../../src/common/crypto/webhook-signer';

describe('WebhookSigner', () => {
  const secret = 'test-secret';
  const signer = new WebhookSigner(secret);
  const body = JSON.stringify({ id: 'evt_1', event_type: 'payment.succeeded' });

  it('accepts a correct signature', () => {
    const ts = String(Date.now());
    const sig = signer.sign(ts, body);
    expect(signer.verify(ts, body, sig)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const ts = String(Date.now());
    const sig = signer.sign(ts, body);
    expect(signer.verify(ts, body + 'x', sig)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const ts = String(Date.now());
    const sig = new WebhookSigner('other-secret').sign(ts, body);
    expect(signer.verify(ts, body, sig)).toBe(false);
  });

  it('rejects a stale (replayed) payload outside the window', () => {
    const old = String(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const sig = signer.sign(old, body);
    expect(signer.verify(old, body, sig)).toBe(false);
  });

  it('rejects a missing signature/timestamp', () => {
    expect(signer.verify('', body, '')).toBe(false);
  });
});
