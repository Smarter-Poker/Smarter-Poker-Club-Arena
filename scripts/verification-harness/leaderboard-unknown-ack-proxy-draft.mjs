// UNQUALIFIED DRAFT: transparent transport fault fixture, never production.
// Requires Node inside the owning disposable container; installs nothing.
import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';

const payoutSHA256 = 'c5c72aedd0c36373c87d15f8b23266e0cf6e35131130c96db3e6b9d8379a6fac';

const sockets = new Set();
let gated = false;
let committedQuery = false;
let admitted = false;
let failed = false;
let releasing = false;
const fail = (message) => {
  failed = true;
  console.error(message);
  for (const socket of sockets) socket.destroy();
  process.exitCode = 1;
  server.close();
  control.close();
};
const timer = setTimeout(() => fail('Unknown-ack proxy deadline expired'), 70000);
const server = net.createServer((client) => {
  if (admitted) return fail('Exactly one PostgreSQL client is permitted');
  admitted = true;
  const upstream = net.createConnection('/tmp/.s.PGSQL.5432');
  sockets.add(client);
  sockets.add(upstream);
  let startup = true;
  let buffered = Buffer.alloc(0);
  let outstanding = false;
  let expectedQuery = 0;
  const expected = ['BEGIN;', "SET LOCAL application_name='lb-unknown-ack';", 'PAYOUT', 'COMMIT;'];
  let backend = Buffer.alloc(0);
  upstream.on('data', (chunk) => {
    // Quarantine the entire response, including CommandComplete and ReadyForQuery.
    // Nothing is fabricated or delivered after COMMIT is forwarded.
    if (gated) return;
    backend = Buffer.concat([backend, chunk]);
    while (backend.length >= 5) {
      const size = backend.readUInt32BE(1) + 1;
      if (size < 5 || size > 16 * 1024 * 1024) return fail('Invalid backend frame');
      if (backend.length < size) break;
      const frame = backend.subarray(0, size);
      backend = backend.subarray(size);
      if (frame[0] === 90) outstanding = false; // ReadyForQuery
      client.write(frame);
    }
  });
  client.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= (startup ? 4 : 5)) {
      const size = startup ? buffered.readUInt32BE(0) : buffered.readUInt32BE(1) + 1;
      if (size < (startup ? 8 : 5) || size > 1024 * 1024) return fail('Invalid frontend frame');
      if (buffered.length < size) break;
      const frame = buffered.subarray(0, size);
      buffered = buffered.subarray(size);
      if (startup) {
        if (frame.readUInt32BE(4) !== 196608)
          return fail('Only plaintext protocol v3 is permitted');
        startup = false;
        outstanding = true;
        upstream.write(frame);
        continue;
      }
      if (frame[0] !== 81 || outstanding || committedQuery)
        return fail('Unexpected protocol or pipelining');
      if (frame.at(-1) !== 0) return fail('Query lacks terminator');
      const query = frame.subarray(5, -1).toString('utf8').trim();
      const want = expected[expectedQuery++];
      if (want === 'PAYOUT') {
        // Fixed test transaction only, not arbitrary SQL accepted by a proxy.
        if (createHash('sha256').update(query).digest('hex') !== payoutSHA256)
          return fail('Payout statement differs from reviewed literal');
      } else if (query !== want) return fail('Unexpected SQL statement');
      outstanding = true;
      if (query === 'COMMIT;') {
        committedQuery = true;
        gated = true;
        console.log('COMMIT_FORWARDED_ACK_QUARANTINED');
      }
      upstream.write(frame);
    }
  });
  for (const socket of [client, upstream]) {
    socket.on('error', (error) => {
      if (!releasing) fail(`Transport error: ${error.code}`);
    });
    socket.on('close', () => sockets.delete(socket));
  }
});
const control = http.createServer((request, response) => {
  if (
    request.method !== 'POST' ||
    request.url !== '/release' ||
    !gated ||
    !committedQuery ||
    failed
  ) {
    response.writeHead(409).end();
    return;
  }
  // Called only after the driver independently sees the committed financial state.
  releasing = true;
  for (const socket of sockets) socket.destroy();
  response.writeHead(204).end();
  clearTimeout(timer);
  server.close();
  control.close();
});
server.listen(15432, '127.0.0.1');
control.listen(15433, '127.0.0.1');
const stop = () => fail('Owned proxy interrupted');
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
