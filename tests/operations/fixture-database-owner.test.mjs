import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import pg from 'pg';
import { once, EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  NativeDatabaseOwner,
  nativeFailureDiagnostic,
} from '../../operations/release/fixture/runtime-files.mjs';

function packet(type, payload) {
  const length = Buffer.alloc(4);
  length.writeInt32BE(payload.length + 4);
  return Buffer.concat([Buffer.from(type), length, payload]);
}

test('actual pg idle wire error is sanitized, aborts a real child and closes its socket', async () => {
  // Minimal wire peer only; this proves driver failure ownership, not a SQL server.
  const peers = new Set();
  let peer;
  const server = net.createServer((socket) => {
    peer = socket;
    peers.add(socket);
    socket.once('close', () => peers.delete(socket));
    socket.once('data', () =>
      socket.write(Buffer.concat([packet('R', Buffer.alloc(4)), packet('Z', Buffer.from('I'))]))
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const owner = new NativeDatabaseOwner();
  const client = owner.own(
    new pg.Client({
      host: '127.0.0.1',
      port: server.address().port,
      user: 'synthetic_owner',
      database: 'synthetic_db',
      ssl: false,
      connectionTimeoutMillis: 3000,
    })
  );
  try {
    await client.connect();
    const command = promisify(execFile)(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      signal: owner.signal,
    });
    const stopped = assert.rejects(command, { name: 'AbortError' });
    peer.end(packet('E', Buffer.from('SFATAL\0C57P01\0MPRIVATE SERVICE PASSWORD\0\0')));
    await stopped;
    assert.equal(owner.signal.aborted, true);
    assert.throws(() => owner.check(), /native database connection failed/);
    assert.deepEqual(nativeFailureDiagnostic('postgresql-client-connection', owner.failure), {
      status: 'failed',
      stage: 'postgresql-client-connection',
      error: 'error',
      sqlstate: '57P01',
    });
    assert.ok(!String(owner.failure.stack).includes('PRIVATE'));
    assert.ok(!JSON.stringify(owner.failure).includes('PRIVATE'));
    await owner.close();
    assert.equal(client._ended, true);
    assert.throws(() => owner.own(new pg.Client()), /unavailable/);
  } finally {
    for (const socket of peers) socket.destroy();
    await owner.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('database close is joined once and delayed failure cannot leak after close', async () => {
  const owner = new NativeDatabaseOwner();
  const client = new EventEmitter();
  let ends = 0;
  client.end = async () => {
    ends++;
  };
  owner.own(client);
  await owner.end(client);
  await owner.close();
  await owner.close();
  assert.equal(ends, 1);
  assert.doesNotThrow(() => client.emit('error', new Error('PRIVATE')));
  assert.equal(String(owner.failure), 'Error: native database connection failed');
});

test('unobserved database close fails within its own deadline', async () => {
  const owner = new NativeDatabaseOwner();
  const client = new EventEmitter();
  client.end = () => new Promise(() => {});
  owner.own(client);
  await assert.rejects(owner.close(10), /close timed out/);
});
