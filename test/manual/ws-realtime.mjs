import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { WebhookSigner } from '../../dist/common/crypto/webhook-signer.js';

const BASE = 'http://localhost:3000';
const JWT_SECRET = 'dev-insecure-jwt-secret';
const signer = new WebhookSigner('dev-webhook-shared-secret');

const post = (path, body, headers = {}) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

(async () => {
  const userId = crypto.randomUUID();
  const token = jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '15m' });

  const created = await post('/payments', { orderId: crypto.randomUUID(), userId, amount: 88.5, currency: 'USD' });
  const paymentId = created.body.id;
  console.log('[create] status=' + created.status + ' state=' + created.body.status);

  const socket = io(BASE, { auth: { token }, transports: ['websocket'] });
  const updates = [];
  socket.on('payment:update', (e) => { updates.push(e); console.log('[ws] payment:update ' + JSON.stringify(e)); });

  await new Promise((res) => socket.on('connect', res));
  console.log('[ws] connected sid=' + socket.id);

  const sub = await new Promise((res) => socket.emit('payment:subscribe', { paymentId }, res));
  console.log('[ws] subscribe -> ' + JSON.stringify(sub));
  await new Promise((r) => setTimeout(r, 300));

  const ts = String(Date.now());
  const raw = JSON.stringify({ id: 'evt_ws_' + crypto.randomUUID(), event_type: 'payment.succeeded', payment_id: paymentId, transaction_id: 'txn_ws', event_time: Date.now(), data: { amount: 88.5 } });
  const sig = signer.sign(ts, raw);
  const w = await post('/webhooks/payment', JSON.parse(raw), { 'x-signature': sig, 'x-timestamp': ts });
  console.log('[webhook] status=' + w.status + ' disposition=' + w.body.disposition);

  await new Promise((r) => setTimeout(r, 1200));

  const live = updates.filter((u) => u.eventType === 'payment.succeeded');
  console.log('LIVE_UPDATES=' + live.length + ' (expect >=1 with paymentId=' + paymentId + ')');
  socket.close();
  process.exit(live.length >= 1 ? 0 : 1);
})();