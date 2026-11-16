import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json } from 'express';
import request from 'supertest';
import { WebhooksController } from '../../src/modules/webhooks/webhooks.controller';
import { WebhookSignatureGuard } from '../../src/modules/webhooks/webhook-signature.guard';
import { WebhooksService } from '../../src/modules/webhooks/webhooks.service';
import { WebhookSigner } from '../../src/common/crypto/webhook-signer';

const WEBHOOK_SECRET = 'integration-secret';

describe('POST /webhooks/payment (guard + controller)', () => {
  let app: INestApplication;
  const service = { handleWebhook: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        { provide: WebhooksService, useValue: service },
        WebhookSignatureGuard,
        {
          provide: ConfigService,
          useValue: { get: (k: string) => (k === 'webhook.secret' ? WEBHOOK_SECRET : undefined) },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirror main.ts: capture rawBody for HMAC verification.
    app.use(
      json({
        verify: (req: any, _res: any, buf: Buffer) => {
          req.rawBody = buf.toString('utf8');
        },
      }),
    );
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const body = {
    id: 'evt_1',
    event_type: 'payment.succeeded',
    payment_id: '00000000-0000-4000-8000-000000000001',
    data: { amount: 999 },
  };

  it('rejects an unsigned request with 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/payment')
      .send(body)
      .expect(401);
    expect(res.body.code).toBe('BAD_SIGNATURE');
    expect(service.handleWebhook).not.toHaveBeenCalled();
  });

  it('accepts a correctly signed request and calls the service', async () => {
    service.handleWebhook.mockResolvedValueOnce({
      received: true,
      event_id: 'evt_1',
      disposition: 'accepted',
    });

    // The guard re-serializes req.body, so sign the same compact JSON.
    const signer = new WebhookSigner(WEBHOOK_SECRET);
    const ts = String(Date.now());
    const raw = JSON.stringify(body);
    const sig = signer.sign(ts, raw);

    await request(app.getHttpServer())
      .post('/webhooks/payment')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .set('X-Timestamp', ts)
      .send(raw)
      .expect(200);

    expect(service.handleWebhook).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale (replayed) signature outside the window', async () => {
    const signer = new WebhookSigner(WEBHOOK_SECRET);
    const old = String(Date.now() - 10 * 60 * 1000);
    const sig = signer.sign(old, JSON.stringify(body));

    await request(app.getHttpServer())
      .post('/webhooks/payment')
      .set('X-Signature', sig)
      .set('X-Timestamp', old)
      .send(JSON.stringify(body))
      .expect(401);
  });
});
