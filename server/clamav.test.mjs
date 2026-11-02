import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { scanWithClamd } from './clamav.mjs';

// Protocol fixtures only: these tests do not claim to run an antivirus engine.
async function scanner(t, reply) {
  let received;
  const server = net.createServer(socket => {
    let pending = Buffer.alloc(0);
    let command = false;
    let complete = false;
    const chunks = [];
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      if (!command) {
        const separator = pending.indexOf(0);
        if (separator < 0) return;
        assert.equal(pending.subarray(0, separator).toString(), 'zINSTREAM');
        pending = pending.subarray(separator + 1);
        command = true;
      }
      while (!complete && pending.length >= 4) {
        const length = pending.readUInt32BE();
        if (!length) {
          complete = true;
          received = Buffer.concat(chunks);
          reply(socket);
          return;
        }
        if (pending.length < 4 + length) return;
        chunks.push(Buffer.from(pending.subarray(4, 4 + length)));
        pending = pending.subarray(4 + length);
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {
    options: { host: '127.0.0.1', port: server.address().port, timeout: 500 },
    get received() { return received; },
  };
}

test('INSTREAM sends complete file bytes and accepts only a complete clean response', async t => {
  const fake = await scanner(t, socket => {
    socket.write('stream: ');
    setImmediate(() => socket.end('OK\0'));
  });
  const data = Buffer.alloc(1024 * 1024 + 123, 0x25);
  await scanWithClamd(data, fake.options);
  assert.deepEqual(fake.received, data);
});

test('INSTREAM infection is distinguishable from scanner unavailability', async t => {
  const fake = await scanner(t, socket => socket.end('stream: Test.Signature FOUND\0'));
  await assert.rejects(scanWithClamd(Buffer.from('test-only-data'), fake.options), { code: 'infected_file' });
});

test('truncated or malformed scanner response fails closed', async t => {
  const incomplete = await scanner(t, socket => socket.end('stream: OK'));
  await assert.rejects(scanWithClamd(Buffer.from('data'), incomplete.options), /scanner_incomplete/);
  const malformed = await scanner(t, socket => socket.end('stream: UNKNOWN\0'));
  await assert.rejects(scanWithClamd(Buffer.from('data'), malformed.options), /scanner_failed/);
});

test('silent scanner times out without approving the file', async t => {
  const fake = await scanner(t, () => {});
  await assert.rejects(scanWithClamd(Buffer.from('data'), { ...fake.options, timeout: 30 }), /scanner_timeout/);
});

test('unavailable scanner cannot approve files', async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(scanWithClamd(Buffer.from('data'), { host: '127.0.0.1', port, timeout: 100 }), /scanner_unavailable/);
});
