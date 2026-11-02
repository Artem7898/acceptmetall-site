// Manual browser integration: build first, then node tests/browser-smoke.mjs.
// Uses only loopback, a temporary database, and in-process mail/scanner fakes.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createOrderService } from '../server/app.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jaxkAAAAASUVORK5CYII=', 'base64');
const directory = await mkdtemp(join(tmpdir(), 'acceptmetall-browser-'));
const assets = resolve('dist');
const messages = [];
const requests = [];
let service;
let browser;
let unavailable = false;
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    if (req.method === 'POST') requests.push(req.headers['idempotency-key']);
    if (unavailable) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'service_unavailable' }));
      req.resume();
    } else service.server.emit('request', req, res);
    return;
  }
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const path = resolve(assets, `.${pathname}`);
    if (!path.startsWith(`${assets}/`)) throw new Error('invalid path');
    const bytes = await readFile(path);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
});

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  service = await createOrderService({
    dbPath: join(directory, 'orders.sqlite'), origins: [origin], production: false,
    adminToken: 'browser-test-only-admin-token-at-least-32-characters',
    recipients: { ru: 'orders@example.invalid', en: 'orders@example.invalid' },
    mailFrom: 'sender@example.invalid', rateLimit: 100, retentionDays: 90,
    sendMail: async message => messages.push(message), scanFile: async () => {},
  });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const externalRequests = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
  await context.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.cspViolations.push(`${event.effectiveDirective}: ${event.blockedURI}`));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const violations = [];
  async function open(path) {
    await page.goto(`${origin}${path}`);
    await page.waitForFunction(() => !document.querySelector('[data-order-fields]').disabled);
  }
  async function fill(prefix, company = 'Browser test &bcc=not-a-recipient@example.invalid') {
    await page.locator(`#${prefix}-name`).fill('Browser customer');
    await page.locator(`#${prefix}-company`).fill(company);
    await page.locator(`#${prefix}-phone`).fill('+7 (900) 000-00-00');
    await page.locator(`#${prefix}-email`).fill('customer@example.invalid');
  }
  async function submit(formId, expectedStatus) {
    const responsePromise = page.waitForResponse(response => response.url() === `${origin}/api/orders` && response.request().method() === 'POST');
    await page.locator(`#${formId} [data-order-submit]`).click();
    const response = await responsePromise;
    assert.equal(response.status(), expectedStatus);
    return response.json();
  }

  await open('/');
  await fill('quote');
  await page.locator('#quote-file').setInputFiles({ name: 'drawing.png', mimeType: 'image/png', buffer: png });
  await page.locator('#quoteForm [name="consent"]').check();
  const quote = await submit('quoteForm', 201);
  await page.locator('[data-order-result="quoteForm"]').waitFor({ state: 'visible' });
  assert((await page.locator('[data-order-result="quoteForm"]').textContent()).includes(quote.orderId));
  assert(await page.locator('#quoteForm').isHidden());
  await service.flushOutbox();
  assert.equal(messages.length, 1);
  assert.deepEqual(Buffer.from(messages[0].attachments[0].content), png);
  assert.equal(messages[0].bcc, undefined);
  violations.push(...await page.evaluate(() => window.cspViolations));
  console.log('PASS RU quote: saved reference, private attachment bytes, safe notification headers');

  await open('/en/');
  await fill('contact');
  await page.locator('#contact-message').fill('Please call me.');
  await page.locator('#compactForm [name="consent"]').check();
  const contact = await submit('compactForm', 201);
  await page.locator('[data-order-result="compactForm"]').waitFor({ state: 'visible' });
  assert((await page.locator('[data-order-result="compactForm"]').textContent()).includes(contact.orderId));
  assert(await page.locator('#compactForm').isHidden());
  await service.flushOutbox();
  assert.equal(messages.length, 2);
  assert.equal(messages[1].to, 'orders@example.invalid');
  violations.push(...await page.evaluate(() => window.cspViolations));
  console.log('PASS EN contact: saved reference and server-selected notification recipient');

  await open('/');
  await fill('quote', 'Retain these fields');
  await page.locator('#quoteForm [name="consent"]').check();
  unavailable = true;
  await submit('quoteForm', 503);
  await page.locator('#quoteForm [data-order-error]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#quote-company').inputValue(), 'Retain these fields');
  assert(await page.locator('#quoteForm').isVisible());
  assert(await page.locator('[data-order-result="quoteForm"]').isHidden());
  const failureKey = requests.at(-1);
  unavailable = false;
  await submit('quoteForm', 201);
  assert.equal(requests.at(-1), failureKey);
  await page.locator('[data-order-result="quoteForm"]').waitFor({ state: 'visible' });
  violations.push(...await page.evaluate(() => window.cspViolations));
  assert.equal(service.db.prepare('SELECT count(*) AS count FROM orders').get().count, 3);
  console.log('PASS outage/retry: fields retained, no false success, same retry key, one saved order');

  const noJs = await browser.newContext({ javaScriptEnabled: false });
  const fallback = await noJs.newPage();
  await fallback.goto(`${origin}/`);
  assert.equal(await fallback.locator('#quoteForm').getAttribute('method'), 'post');
  assert.equal(await fallback.locator('#compactForm').getAttribute('method'), 'post');
  assert(await fallback.locator('#quote-name').isDisabled());
  assert(await fallback.locator('#contact-name').isDisabled());
  assert(await fallback.locator('#quoteForm [data-order-submit]').isDisabled());
  assert(await fallback.locator('#compactForm [data-order-submit]').isDisabled());
  console.log('PASS JavaScript disabled: both POST forms disabled; no default GET with personal data');
  assert.deepEqual(errors, []);
  assert.deepEqual(violations, []);
  assert.deepEqual(externalRequests, []);
  console.log('PASS production CSP: no policy violations, JS exceptions, or external requests');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  if (service) await service.close();
  await rm(directory, { recursive: true, force: true });
}
