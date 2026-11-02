import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrderClient, MAX_ATTACHMENT_SIZE, resolveOrderEndpoint } from '../src/scripts/order-client.mjs';

const id = '7f4b8845-dd58-4581-aae2-880adcd93eab';
function payload() {
  const data = new FormData();
  data.set('kind', 'quote');
  data.set('lang', 'ru');
  data.set('name', 'Customer');
  data.set('company', 'Company &bcc=other@example.invalid');
  data.set('email', 'customer@example.invalid');
  data.set('consent', 'yes');
  return data;
}
const accepted = () => Response.json({ status: 'received', orderId: id }, { status: 201 });

test('failed attempt retains form data and idempotency key; edited request gets a new key', async () => {
  const requests = [];
  const client = createOrderClient({ endpoint: '/api/orders', fetchImpl: async (url, options) => {
    requests.push({ url, key: options.headers['Idempotency-Key'], body: options.body });
    if (requests.length === 1) throw new TypeError('Network lost after request');
    return accepted();
  } });
  const data = payload();
  await assert.rejects(client.submit(data), { code: 'network' });
  assert.equal(data.get('company'), 'Company &bcc=other@example.invalid');
  assert.equal(await client.submit(data), id);
  assert.equal(requests[0].key, requests[1].key);
  assert.equal(requests[0].url, '/api/orders');
  assert.equal(requests[0].body.get('company'), 'Company &bcc=other@example.invalid');
  data.set('company', 'Edited company');
  await client.submit(data);
  assert.notEqual(requests[1].key, requests[2].key);
});

test('attachment content participates in retry identity even when name and size match', async () => {
  const keys = [];
  const client = createOrderClient({ endpoint: '/api/orders', fetchImpl: async (_, options) => {
    keys.push(options.headers['Idempotency-Key']);
    return accepted();
  } });
  const data = payload();
  data.set('file', new File(['aaa'], 'file.pdf', { type: 'application/pdf' }));
  await client.submit(data);
  await client.submit(data);
  assert.equal(keys[0], keys[1]);
  data.set('file', new File(['bbb'], 'file.pdf', { type: 'application/pdf' }));
  await client.submit(data);
  assert.notEqual(keys[1], keys[2]);
});

test('a repeated click during an outstanding request does not make a second request', async () => {
  let finish;
  let calls = 0;
  const client = createOrderClient({ endpoint: '/api/orders', fetchImpl: async () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  } });
  const first = client.submit(payload());
  await assert.rejects(client.submit(payload()), { code: 'busy' });
  await new Promise(resolve => setImmediate(resolve));
  finish(accepted());
  assert.equal(await first, id);
  assert.equal(calls, 1);
});

test('unconfirmed, invalid and failed server responses never produce an order reference', async () => {
  for (const response of [
    Response.json({ status: 'received', orderId: '<script>injected</script>' }),
    Response.json({ status: 'sent', orderId: id }),
    Response.json({ status: 'received', orderId: id }, { status: 202 }),
    Response.json({ error: 'rate_limited' }, { status: 429 }),
    new Response('<html>Error page</html>', { status: 200 }),
  ]) {
    const client = createOrderClient({ endpoint: '/api/orders', fetchImpl: async () => response });
    await assert.rejects(client.submit(payload()));
  }
});

test('a timeout rejects confirmation and permits retry with the same request key', async () => {
  const keys = [];
  const client = createOrderClient({ endpoint: '/api/orders', timeoutMs: 5, fetchImpl: async (_, options) => {
    keys.push(options.headers['Idempotency-Key']);
    if (keys.length > 1) return accepted();
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError'))));
  } });
  await assert.rejects(client.submit(payload()), { code: 'timeout' });
  await client.submit(payload());
  assert.equal(keys[0], keys[1]);
});

test('unsupported, empty and oversized attachments are blocked before network access', async () => {
  let calls = 0;
  const client = createOrderClient({ endpoint: '/api/orders', fetchImpl: async () => { calls++; return accepted(); } });
  for (const file of [new File(['a'], 'file.exe'), new File([], 'file.pdf'), new File([new Uint8Array(MAX_ATTACHMENT_SIZE + 1)], 'file.pdf')]) {
    const data = payload();
    data.set('file', file);
    await assert.rejects(client.submit(data));
  }
  assert.equal(calls, 0);
  const noFile = payload();
  noFile.set('file', new File([], ''));
  await client.submit(noFile);
  assert.equal(noFile.has('file'), false);
});

test('API configuration cannot send form data to insecure or credential-bearing URLs', () => {
  assert.equal(resolveOrderEndpoint(), '/api/orders');
  assert.equal(resolveOrderEndpoint('https://api.example.invalid/api/orders'), 'https://api.example.invalid/api/orders');
  for (const url of ['http://api.example.invalid/api/orders', 'https://user:secret@api.example.invalid/api/orders', '//example.invalid/api/orders', 'https://api.example.invalid/api/orders?secret=1', 'https://api.example.invalid/api/orders#fragment']) {
    assert.throws(() => resolveOrderEndpoint(url));
  }
});
