import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

// No caller-supplied hostname, port, redirect or payload. The owned loopback
// listener is reachable only inside the disposable fixture container.
export async function createProviderProbePeer() {
  const token = randomBytes(16).toString('hex');
  const names = ['http', 'commit', 'rollback', 'sentinel'];
  const hits = Object.fromEntries(names.map((name) => [name, 0]));
  const sockets = new Set();
  let invalid = false;
  const body = JSON.stringify({ fixture: token });
  const server = createServer({ maxHeaderSize: 2048, requestTimeout: 2000, headersTimeout: 2000 }, (req, res) => {
    const name = names.find((name) => req.url === '/' + token + '/' + name);
    if (req.method !== 'GET' || !name || req.headers['content-length'] || req.headers['transfer-encoding']) {
      invalid = true;
      res.writeHead(400, { Connection: 'close' }).end();
      return;
    }
    hits[name]++;
    if (hits[name] > 1) invalid = true;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' }).end(body);
  });
  server.maxConnections = 4;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.setTimeout(2000, () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  return {
    body,
    url(name) {
      assert.ok(names.includes(name));
      return `http://127.0.0.1:${address.port}/${token}/${name}`;
    },
    assertHits(expected) {
      assert.equal(invalid, false, 'FIXTURE_PROVIDER_UNEXPECTED_HTTP');
      assert.deepEqual(hits, expected, 'FIXTURE_PROVIDER_HTTP_COUNTS');
    },
    async close() {
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
      assert.equal(server.listening, false);
    },
  };
}
