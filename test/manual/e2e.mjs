import crypto from 'crypto';
import { WebhookSigner } from '../../dist/common/crypto/webhook-signer.js';

const BASE = 'http://localhost:3000';
const signer = new WebhookSigner('dev-webhook-shared-secret');

function post(path, body, headers = {}) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}
function get(path) {
  return fetch(BASE + path).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}
function signed(body) {
  const ts = String(Date.now());
  const raw = JSON.stringify(body);
  const sig = signer.sign(ts, raw);
  return { headers: { 'x-signature': sig, 'x-timestamp': ts }, raw };
}

(async () => {
  const order = crypto.randomUUID();
  const user = crypto.randomUUID();
  const evtSucc = 'evt_' + crypto.randomUUID();
  const evtFail = 'evt_' + crypto.randomUUID();
  const created = await post('/payments', { orderId: order, userId: user, amount: 250.0, currency: 'USD' });
  const paymentId = created.body.id;
  console.log('[create payment] status=' + created.status + ' state=' + created.body.status + ' id=' + paymentId);

  let r = await (async () => { const s = signed({ id: evtSucc, event_type: 'payment.succeeded', payment_id: paymentId, transaction_id: 'txn_s', event_time: Date.now(), data: { amount: 250 } }); return post('/webhooks/payment', JSON.parse(s.raw), s.headers); })();
  console.log('[webhook succeeded] status=' + r.status + ' disposition=' + r.body.disposition + ' (expect accepted)');

  r = await (async () => { const s = signed({ id: evtSucc, event_type: 'payment.succeeded', payment_id: paymentId, transaction_id: 'txn_s', event_time: Date.now(), data: { amount: 250 } }); return post('/webhooks/payment', JSON.parse(s.raw), s.headers); })();
  console.log('[webhook DUPLICATE succeeded] status=' + r.status + ' disposition=' + r.body.disposition + ' (expect duplicate)');

  r = await (async () => { const s = signed({ id: evtFail, event_type: 'payment.failed', payment_id: paymentId, transaction_id: 'txn_f', event_time: Date.now(), data: { amount: 250 } }); return post('/webhooks/payment', JSON.parse(s.raw), s.headers); })();
  console.log('[webhook late FAILED on SUCCESS] status=' + r.status + ' disposition=' + r.body.disposition + ' (expect ignored)');

  r = await post('/webhooks/payment', { id: 'x', event_type: 'payment.succeeded' });
  console.log('[webhook missing signature] status=' + r.status + ' (expect 401)');

  const fetched = await get('/payments/' + paymentId);
  console.log('[GET payment] status=' + fetched.status + ' finalStatus=' + fetched.body.status + ' (expect SUCCESS)');
})();