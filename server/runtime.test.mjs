import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

async function until(check, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(`Timed out: ${description}`);
}

test('runtime entry point saves an order and sends its notification through the SMTP adapter', { timeout: 20000 }, async t => {
  // A protocol-only SMTP sink bound to loopback; it never relays mail or uses TLS.
  // Development mode permits this isolated test; production requires TLS.
  const messages = [];
  const recipients = [];
  const commands = [];
  const sockets = new Set();
  const smtp = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('220 loopback.test ESMTP test sink\r\n');
    let buffer = '';
    let receivingData = false;
    let body = '';
    socket.on('data', data => {
      buffer += data.toString('utf8');
      let separator;
      while ((separator = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        if (receivingData) {
          if (line === '.') {
            messages.push(body);
            body = '';
            receivingData = false;
            socket.write('250 2.0.0 accepted by test sink\r\n');
          } else body += `${line.replace(/^\.\./, '.')}\r\n`;
          continue;
        }
        const verb = line.split(' ', 1)[0].toUpperCase();
        commands.push(verb); // Never capture AUTH payloads, even test credentials.
        if (verb === 'EHLO') socket.write('250-loopback.test\r\n250 AUTH PLAIN\r\n');
        else if (verb === 'HELO') socket.write('250 loopback.test\r\n');
        else if (verb === 'AUTH') socket.write('235 2.7.0 authenticated test connection\r\n');
        else if (verb === 'MAIL') socket.write('250 2.1.0 sender accepted\r\n');
        else if (verb === 'RCPT') { recipients.push(line); socket.write('250 2.1.5 recipient accepted\r\n'); }
        else if (verb === 'DATA') { receivingData = true; socket.write('354 end with dot\r\n'); }
        else if (verb === 'QUIT') socket.end('221 2.0.0 goodbye\r\n');
        else if (verb === 'RSET' || verb === 'NOOP') socket.write('250 2.0.0 OK\r\n');
        else socket.write('500 unsupported test command\r\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    smtp.once('error', reject);
    smtp.listen(0, '127.0.0.1', resolve);
  });
  const directory = await mkdtemp(join(tmpdir(), 'acceptmetall-runtime-test-'));
  const port = await freePort();
  const origin = 'http://127.0.0.1:4321';
  const adminToken = 'runtime-test-admin-token-not-a-secret-32-characters';
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'development', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port),
      SMTP_USER: 'test-user', SMTP_PASSWORD: 'test-password',
      ORDER_TO: 'manager@example.invalid', ORDER_FROM: 'orders@example.invalid',
      ORDER_ADMIN_TOKEN: adminToken, ORDER_ALLOWED_ORIGINS: origin,
      ORDER_HOST: '127.0.0.1', ORDER_PORT: String(port),
      ORDER_DB_PATH: join(directory, 'orders.sqlite'), ORDER_RETENTION_DAYS: '1',
      ORDER_RATE_LIMIT: '100', ORDER_TRUSTED_PROXIES: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', data => { logs += data.toString(); });
  child.stderr.on('data', data => { logs += data.toString(); });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 2000);
    killer.unref();
    await exited;
    clearTimeout(killer);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => smtp.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await until(() => {
    assert.equal(child.exitCode, null, 'server entry point exited unexpectedly');
    return logs.includes('order_api_ready');
  }, 'server readiness');

  const data = new FormData();
  for (const [name, value] of Object.entries({
    kind: 'quote', lang: 'en', consent: 'yes', website: '', name: 'Runtime Test',
    company: 'Sample company', phone: '+70000000000', email: 'customer@example.invalid',
    comment: 'Loopback SMTP adapter integration test',
  })) data.set(name, value);
  const base = `http://127.0.0.1:${port}`;
  const accepted = await fetch(`${base}/api/orders`, {
    method: 'POST', body: data,
    headers: { Origin: origin, 'Idempotency-Key': randomUUID() },
  });
  assert.equal(accepted.status, 201);
  const { orderId } = await accepted.json();
  let order;
  await until(async () => {
    const response = await fetch(`${base}/api/admin/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(response.status, 200);
    ({ order } = await response.json());
    return order.notificationStatus === 'sent';
  }, 'real SMTP adapter acceptance and persisted notification state');
  assert.equal(messages.length, 1);
  assert(commands.includes('AUTH'));
  assert.deepEqual(recipients, ['RCPT TO:<manager@example.invalid>']);
  assert(messages[0].includes(`Subject: Website order ${orderId}`));
  assert(messages[0].includes('Reply-To: customer@example.invalid'));
  assert(messages[0].includes('Loopback SMTP adapter integration test'));
  assert.equal(order.attempts, 1);
});
