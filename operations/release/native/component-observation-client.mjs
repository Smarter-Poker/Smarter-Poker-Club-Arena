import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  OBSERVATION_SOCKET,
  REQUEST_BYTES,
  REPLY_BYTES,
  PERSISTENCE_MS,
  READ_MS,
  keys,
  validateBinding,
  validateHand,
  validateResponse,
} from './component-observation-protocol.mjs';

export function createObservationClient(descriptor, control, testHarness = {}) {
  keys(control, ['version', 'control_sha']);
  assert.equal(control.version, 1);
  assert.match(control.control_sha, /^[0-9a-f]{40}$/);
  keys(descriptor, [
    'version',
    'instance_id',
    'control_sha',
    'table_id',
    'spectator_user_id',
    'socket',
  ]);
  const { socket: socketPath, ...values } = descriptor;
  const binding = validateBinding(values);
  assert.equal(binding.control_sha, control.control_sha);
  assert.equal(socketPath, testHarness.socketPath ?? OBSERVATION_SOCKET);
  assert.equal(process.getuid(), testHarness.observerUid ?? 1001);
  assert.equal(process.getgid(), testHarness.observerGid ?? 1001);
  if (!testHarness.allowSharedTestIdentity) assert.ok(!process.getgroups().includes(1000));
  const now = testHarness.now ?? (() => performance.now());
  let hand = null,
    deadline = null,
    closed = false,
    busy = false;
  const sockets = new Set();
  async function read(kind, value) {
    assert.ok(!closed && !busy, 'OBSERVATION_CLIENT_UNAVAILABLE');
    busy = true;
    try {
      const parent = await lstat(path.dirname(socketPath)),
        stat = await lstat(socketPath);
      const fixtureUid = testHarness.fixtureUid ?? 1000,
        observerGid = testHarness.observerGid ?? 1001;
      assert.ok(
        parent.isDirectory() &&
          !parent.isSymbolicLink() &&
          parent.uid === fixtureUid &&
          parent.gid === observerGid &&
          (parent.mode & 0o7777) === 0o2750
      );
      assert.ok(
        stat.isSocket() &&
          !stat.isSymbolicLink() &&
          stat.uid === fixtureUid &&
          stat.gid === observerGid &&
          (stat.mode & 0o7777) === 0o660
      );
      if (kind !== 'catalogue') {
        validateHand(value);
        if (!hand) {
          hand = Object.freeze({ ...value });
          deadline = now() + PERSISTENCE_MS;
        }
        assert.deepEqual(value, hand, 'OBSERVATION_HAND_SUBSTITUTION');
        assert.ok(now() < deadline, 'OBSERVATION_PERSISTENCE_DEADLINE');
      }
      const request = {
        version: 1,
        request_id: randomUUID(),
        binding,
        read: kind,
        ...(kind === 'catalogue' ? {} : { hand }),
      };
      const encoded = Buffer.from(JSON.stringify(request) + '\n');
      assert.ok(encoded.length <= REQUEST_BYTES);
      const budget = kind === 'catalogue' ? READ_MS : Math.min(READ_MS, deadline - now());
      assert.ok(budget > 0);
      const result = await new Promise((resolve, reject) => {
        const socket = net.createConnection({ path: socketPath });
        sockets.add(socket);
        let bytes = 0,
          chunks = [],
          complete = false;
        const timer = setTimeout(
          () => socket.destroy(new Error('OBSERVATION_CLIENT_DEADLINE')),
          budget
        );
        socket.on('connect', () => socket.end(encoded));
        socket.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > REPLY_BYTES) {
            socket.destroy(new Error('OBSERVATION_REPLY_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        socket.on('end', () => {
          complete = true;
        });
        socket.on('error', () => reject(new Error('OBSERVATION_CONNECTION_FAILED')));
        socket.on('close', () => {
          clearTimeout(timer);
          sockets.delete(socket);
          try {
            assert.ok(complete);
            const buffer = Buffer.concat(chunks);
            assert.equal(buffer.indexOf(10), buffer.length - 1);
            assert.ok(buffer.length > 1);
            resolve(validateResponse(JSON.parse(buffer.subarray(0, -1).toString('utf8')), request));
          } catch {
            reject(new Error('OBSERVATION_REPLY_REFUSED'));
          }
        });
      });
      if (kind !== 'catalogue') assert.ok(now() < deadline, 'OBSERVATION_PERSISTENCE_DEADLINE');
      return result;
    } catch (error) {
      closed = true;
      for (const socket of sockets) socket.destroy();
      throw error;
    } finally {
      busy = false;
    }
  }
  return Object.freeze({
    binding,
    catalogue: () => read('catalogue'),
    handPresence: (hand) => read('hand_presence', hand),
    handFacts: (hand) => read('hand_facts', hand),
    close() {
      closed = true;
      for (const socket of sockets) socket.destroy();
    },
  });
}
