import crypto from 'crypto';
import { WebhookSigner } from '../../dist/common/crypto/webhook-signer.js';

const BASE = 'http://localhost:3000';
const signer = new WebhookSigner('dev-webhook-shared-secret');
const order = crypto.randomUUID();
const user = crypto.randomUUID();

async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}
const show = (label, r) => console.log(label, '->', r.status, JSON.stringify(r.body).slice(0, 220));

// 1-2. Health
show('[1] GET /health/live', await call('GET', '/health/live'));
show('[2] GET /health/ready', await call('GET', '/health/ready'));

// 3. Create payment
const created = await call('POST', '/payments', { orderId: order, userId: user, amount: 150.25, currency: 'EUR' });
show('[3] POST /payments', created);
const paymentId = created.body.id;

// 4. Get by id
show('[4] GET /payments/:id', await call('GET', `/payments/${paymentId}`));

// 5. List
const list = await call('GET', '/payments?page=1&limit=5');
console.log('[5] GET /payments', '->', list.status, `total=${list.body.total} returned=${list.body.items?.length}`);

// 6. List by status
const byStatus = await call('GET', '/payments?status=PENDING');
console.log('[6] GET /payments?status=PENDING', '->', byStatus.status, `total=${byStatus.body.total}`);

// 7. List by userId
const byUser = await call('GET', `/payments?userId=${user}`);
console.log('[7] GET /payments?userId=...', '->', byUser.status, `total=${byUser.body.total}`);

// 8. Signed webhook: succeeded (accepted)
const evtId = 'evt_' + crypto.randomUUID();
const ts = String(Date.now());
const raw = JSON.stringify({ id: evtId, event_type: 'payment.succeeded', payment_id: paymentId, transaction_id: 'txn_all', event_time: Date.now(), data: { amount: 150.25 } });
const sig = signer.sign(ts, raw);
show('[8] POST /webhooks/payment (signed)', await call('POST', '/webhooks/payment', JSON.parse(raw), { 'x-signature': sig, 'x-timestamp': ts }));

// 9. Same event again (duplicate)
show('[9] POST /webhooks/payment (duplicate)', await call('POST', '/webhooks/payment', JSON.parse(raw), { 'x-signature': sig, 'x-timestamp': ts }));

// 10. Tampered signature (should be 401)
show('[10] POST /webhooks/payment (bad sig)', await call('POST', '/webhooks/payment', JSON.parse(raw), { 'x-signature': 'deadbeef', 'x-timestamp': ts }));

// 11. Invalid create (bad currency) -> 400
show('[11] POST /payments (bad currency)', await call('POST', '/payments', { orderId: crypto.randomUUID(), userId: crypto.randomUUID(), amount: 5, currency: 'DOL' }));

// 12. Nonexistent payment -> 404
show('[12] GET /payments/:id (missing)', await call('GET', `/payments/${crypto.randomUUID()}`));