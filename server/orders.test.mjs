import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOrderService } from './app.mjs';

const origin = 'http://127.0.0.1:4321';
const adminToken = 'test-only-admin-token-at-least-32-characters';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jaxkAAAAASUVORK5CYII=', 'base64');

function form(overrides = {}, attachment) {
  const values = {
    kind: 'quote', lang: 'ru', consent: 'yes', website: '',
    name: 'Тестовый клиент', company: 'Компания &bcc=not-a-recipient@example.invalid',
    phone: '+7 (900) 000-00-00', email: 'customer@example.invalid',
    product: 'Лист', quantity: '12', comment: 'Не отправлять реальные письма',
    ...overrides,
  };
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) result.set(key, value);
  }
  if (attachment) result.set('file', new File([attachment.bytes], attachment.name, { type: attachment.type }));
  return result;
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'acceptmetall-orders-test-'));
  const config = {
    dbPath: join(directory, 'orders.sqlite'), origins: [origin], adminToken,
    recipients: { ru: 'ru@example.invalid', en: 'en@example.invalid' },
    mailFrom: 'orders@example.invalid', sendMail: async () => {},
    scanFile: async () => {}, retentionDays: 90, rateLimit: 100,
    production: false,
    ...options,
  };
  let service;
  let base;
  async function start() {
    service = await createOrderService(config);
    await new Promise((resolve, reject) => {
      service.server.once('error', reject);
      service.server.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${service.server.address().port}`;
  }
  await start();
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get service() { return service; },
    async restart() { await service.close(); await start(); },
    post(body = form(), key = randomUUID(), headers = {}) {
      return fetch(`${base}/api/orders`, {
        method: 'POST', body,
        headers: { Origin: origin, 'Idempotency-Key': key, ...headers },
      });
    },
    get(path, authenticated = true) {
      return fetch(`${base}${path}`, { headers: authenticated ? { Authorization: `Bearer ${adminToken}` } : {} });
    },
  };
}

test('accepted quote has a stable order number, persists across restart, and is private', async t => {
  const app = await fixture(t);
  const response = await app.post();
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.status, 'received');
  assert.match(result.orderId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal((await app.get('/api/admin/orders', false)).status, 401);
  assert.equal((await app.get(`/api/admin/orders/${result.orderId}`, false)).status, 401);
  await app.restart();
  const detail = await app.get(`/api/admin/orders/${result.orderId}`);
  assert.equal(detail.status, 200);
  const { order } = await detail.json();
  assert.equal(order.id, result.orderId);
  assert.equal(order.fields.email, 'customer@example.invalid');
  assert.equal(order.fields.product, 'Лист');
});

test('English contact request uses server-selected recipient and safe mail headers', async t => {
  const messages = [];
  const app = await fixture(t, { sendMail: async message => { messages.push(message); } });
  const response = await app.post(form({ kind: 'contact', lang: 'en', message: 'Please call me.' }));
  assert.equal(response.status, 201);
  const { orderId } = await response.json();
  await app.service.flushOutbox();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, 'en@example.invalid');
  assert.equal(messages[0].from, 'orders@example.invalid');
  assert.equal(messages[0].bcc, undefined);
  assert(!messages[0].subject.includes('not-a-recipient'));
  assert(messages[0].subject.includes(orderId));
  assert(messages[0].text.includes('Please call me.'));
});

test('retry and double click create one order and one notification; changed payload conflicts', async t => {
  const messages = [];
  const app = await fixture(t, { sendMail: async message => { messages.push(message); } });
  const key = randomUUID();
  const [first, second] = await Promise.all([app.post(form(), key), app.post(form(), key)]);
  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  const a = await first.json();
  const b = await second.json();
  assert.equal(a.orderId, b.orderId);
  assert.equal((await app.post(form({ quantity: '13' }), key)).status, 409);
  await app.service.flushOutbox();
  await app.service.flushOutbox();
  assert.equal(messages.length, 1);
  const { orders } = await (await app.get('/api/admin/orders')).json();
  assert.equal(orders.length, 1);
});

test('failed email does not lose the order; queued retry survives service restart', async t => {
  let now = Date.now();
  let fail = true;
  let delivered = 0;
  const app = await fixture(t, {
    clock: () => now,
    sendMail: async () => { if (fail) throw new Error('simulated SMTP outage'); delivered++; },
  });
  const response = await app.post();
  assert.equal(response.status, 201);
  const { orderId } = await response.json();
  await app.service.flushOutbox();
  assert.equal(delivered, 0);
  assert.equal((await app.get(`/api/admin/orders/${orderId}`)).status, 200);
  await app.restart();
  fail = false;
  now += 24 * 60 * 60 * 1000;
  await app.service.flushOutbox();
  assert.equal(delivered, 1);
  await app.service.flushOutbox();
  assert.equal(delivered, 1);
});

test('server rejects missing consent, untrusted origin, unknown fields, and invalid request keys', async t => {
  const app = await fixture(t);
  assert.equal((await app.post(form({ consent: undefined }))).status, 422);
  assert.equal((await app.post(form(), randomUUID(), { Origin: 'https://untrusted.example.invalid' })).status, 403);
  assert.equal((await app.post(form({ to: 'attacker@example.invalid' }))).status, 400);
  assert.equal((await app.post(form(), 'not-a-uuid')).status, 400);
  assert.equal((await app.post(form({ email: 'not an email' }))).status, 422);
  assert.equal((await app.post(form({ kind: 'contact', message: undefined }))).status, 422);
  for (const inheritedName of ['constructor', 'toString', '__proto__']) {
    const body = form();
    body.set(inheritedName, 'must not bypass field allowlist');
    assert.equal((await app.post(body)).status, 400);
  }
  const { orders } = await (await app.get('/api/admin/orders')).json();
  assert.equal(orders.length, 0);
});

test('real attachment bytes are retained privately and included in notification', async t => {
  const messages = [];
  const app = await fixture(t, { sendMail: async message => { messages.push(message); } });
  const response = await app.post(form({}, { bytes: png, name: 'drawing.png', type: 'image/png' }));
  assert.equal(response.status, 201);
  const { orderId } = await response.json();
  assert.equal((await app.get(`/api/admin/orders/${orderId}/attachment`, false)).status, 401);
  const download = await app.get(`/api/admin/orders/${orderId}/attachment`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'image/png');
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
  await app.service.flushOutbox();
  assert.equal(messages.length, 1);
  assert.deepEqual(Buffer.from(messages[0].attachments[0].content), png);
});

test('extension-only checks cannot accept disguised file types; oversized files are rejected', async t => {
  const app = await fixture(t);
  assert.equal((await app.post(form({}, { bytes: Buffer.from('<script>alert(1)</script>'), name: 'document.pdf', type: 'application/pdf' }))).status, 415);
  assert.equal((await app.post(form({}, { bytes: png, name: 'drawing.exe', type: 'image/png' }))).status, 415);
  assert.equal((await app.post(form({}, { bytes: Buffer.alloc(5 * 1024 * 1024 + 1), name: 'huge.pdf', type: 'application/pdf' }))).status, 413);
  const { orders } = await (await app.get('/api/admin/orders')).json();
  assert.equal(orders.length, 0);
});

test('scanner failure fails closed and leaves no order with an unscanned file', async t => {
  const app = await fixture(t, { scanFile: async () => { throw new Error('scanner unavailable'); } });
  const response = await app.post(form({}, { bytes: png, name: 'drawing.png', type: 'image/png' }));
  assert.equal(response.status, 503);
  const { orders } = await (await app.get('/api/admin/orders')).json();
  assert.equal(orders.length, 0);
});

test('scanner-detected infection is rejected instead of stored or emailed', async t => {
  let attemptedNotification = false;
  const app = await fixture(t, {
    scanFile: async () => { throw Object.assign(new Error('test infection'), { code: 'infected_file' }); },
    sendMail: async () => { attemptedNotification = true; },
  });
  const response = await app.post(form({}, { bytes: png, name: 'drawing.png', type: 'image/png' }));
  assert.equal(response.status, 422);
  await app.service.flushOutbox();
  assert.equal(attemptedNotification, false);
  assert.equal((await (await app.get('/api/admin/orders')).json()).orders.length, 0);
});

test('anti-spam honeypot cannot create a real order or notification', async t => {
  const app = await fixture(t);
  assert.equal((await app.post(form({ website: 'https://spam.example.invalid' }))).status, 422);
  assert.equal((await (await app.get('/api/admin/orders')).json()).orders.length, 0);
});

test('rate limiting returns retry guidance rather than accepting unlimited submissions', async t => {
  const app = await fixture(t, { rateLimit: 2 });
  assert.equal((await app.post()).status, 201);
  assert.equal((await app.post()).status, 201);
  const response = await app.post();
  assert.equal(response.status, 429);
  assert(Number(response.headers.get('retry-after')) > 0);
});

test('duplicate fields and malformed multipart fail without creating or corrupting orders', async t => {
  const app = await fixture(t);
  const duplicated = form();
  duplicated.append('email', 'other@example.invalid');
  assert.equal((await app.post(duplicated)).status, 400);
  const incompleteBody = '--test-boundary\r\nContent-Disposition: form-data; name="name"\r\n\r\nunfinished';
  const malformed = await app.post(incompleteBody, randomUUID(), { 'Content-Type': 'multipart/form-data; boundary=test-boundary' });
  assert.equal(malformed.status, 400);
  assert.equal((await (await app.get('/api/admin/orders')).json()).orders.length, 0);
  assert.equal((await app.post()).status, 201);
});

test('retention removes stored personal data and attachments from the application', async t => {
  let now = Date.now();
  const app = await fixture(t, { clock: () => now, retentionDays: 1 });
  const response = await app.post(form({}, { bytes: png, name: 'drawing.png', type: 'image/png' }));
  assert.equal(response.status, 201);
  const { orderId } = await response.json();
  now += 2 * 24 * 60 * 60 * 1000;
  assert.equal((await app.get(`/api/admin/orders/${orderId}`)).status, 404);
  assert.equal((await app.get(`/api/admin/orders/${orderId}/attachment`)).status, 404);
  assert.equal((await (await app.get('/api/admin/orders')).json()).orders.length, 0);
});
