import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { startObservationBridge } from '../../operations/release/fixture/observation-bridge.mjs';
import { createObservationClient } from '../../operations/release/native/component-observation-client.mjs';
import * as protocol from '../../operations/release/native/component-observation-protocol.mjs';

const hand = { hand_number: 17, next_hand_number: 18 };
const facts = {
  count: 1,
  rows: [
    { hand_number: 17, pot_size: '25.00', rake_amount: '1.00', action_count: 2, player_count: 2 },
  ],
  seat_count: 0,
};
async function harness(t, changes = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'obs-'));
  await chmod(directory, 0o2750);
  const socketPath = path.join(directory, 'observation.sock');
  const binding = {
    version: 1,
    instance_id: randomUUID(),
    control_sha: 'a'.repeat(40),
    table_id: randomUUID(),
    spectator_user_id: randomUUID(),
  };
  const db = new EventEmitter();
  db.calls = [];
  db.ended = 0;
  db.query = async (...args) => {
    db.calls.push(args);
    return { rows: [] };
  };
  db.end = async () => {
    db.ended++;
  };
  const observations = {
    captureObservationHandFloor: async () => 0,
    schemaCatalogue: async () => 'b'.repeat(64),
    observeHandPresence: async () => ({ count: 1 }),
    observeHandFacts: async () => facts,
    ...changes.observations,
  };
  const options = {
    socketPath,
    fixtureUid: process.getuid(),
    observerUid: process.getuid(),
    observerGid: process.getgid(),
    allowSharedTestIdentity: true,
    protocol,
    observations,
    ...changes.options,
  };
  const failures = [];
  const bridge = await startObservationBridge(
    {
      db,
      binding,
      financialActors: changes.financialActors,
      onFailure: (value) => failures.push(value),
    },
    options
  );
  t.after(async () => {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  });
  const descriptor = { ...binding, socket: socketPath },
    control = { version: 1, control_sha: binding.control_sha };
  const client = () => createObservationClient(descriptor, control, options);
  return {
    directory,
    socketPath,
    binding,
    db,
    bridge,
    client,
    failures,
    options,
    descriptor,
    control,
  };
}
async function raw(socketPath, value) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    let data = '';
    socket.on('connect', () =>
      socket.end(typeof value === 'string' ? value : JSON.stringify(value) + '\n')
    );
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('error', () => {});
    socket.on('close', () => resolve(data));
  });
}
function request(h, read = 'catalogue', extra = {}) {
  return { version: 1, request_id: randomUUID(), binding: h.binding, read, ...extra };
}

test('three fixed reads preserve binding and socket mode without chmodding parent', async (t) => {
  const h = await harness(t),
    before = await lstat(h.directory),
    client = h.client();
  assert.deepEqual(await client.catalogue(), { catalogue_digest: 'b'.repeat(64) });
  assert.deepEqual(await client.handPresence(hand), { count: 1 });
  assert.deepEqual(protocol.verifyObservedHandFacts(await client.handFacts(hand), hand), {
    hand_number: 17,
    next_hand_number: 18,
    actions: 2,
    players: 2,
    seat_count: 0,
  });
  const after = await lstat(h.directory),
    socket = await lstat(h.socketPath);
  assert.equal(after.mode, before.mode);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode & 0o7777, 0o2750);
  assert.equal(socket.mode & 0o7777, 0o660);
  assert.equal(h.failures.length, 0);
  assert.ok(h.db.calls.some(([sql]) => sql.includes('READ ONLY')));
  client.close();
});

test('malformed, extra SQL, identifier substitution and oversized requests never reach a read', async (t) => {
  const invalid = [
    (h) => '{oops}\n',
    (h) => request(h, 'catalogue', { sql: 'SELECT private_secret FROM auth.users' }),
    (h) => ({ ...request(h), binding: { ...h.binding, table_id: randomUUID() } }),
    (h) => 'x'.repeat(4097),
    (h) => request(h, 'query', { sql: 'DELETE FROM public.profiles' }),
    (h) => JSON.stringify(request(h)) + '\n' + JSON.stringify(request(h)) + '\n',
  ];
  for (const make of invalid) {
    const h = await harness(t);
    const before = h.db.calls.length;
    assert.equal(await raw(h.socketPath, make(h)), '');
    assert.equal(h.db.calls.length, before);
    assert.equal(h.failures.length, 1);
  }
});

test('server binds first hand forever across independent clients', async (t) => {
  const h = await harness(t);
  assert.ok(await raw(h.socketPath, request(h, 'hand_presence', { hand })));
  assert.equal(
    await raw(
      h.socketPath,
      request(h, 'hand_facts', { hand: { hand_number: 19, next_hand_number: 20 } })
    ),
    ''
  );
  assert.equal(h.failures.length, 1);
});

test('historical hand and extended persistence deadline are refused', async (t) => {
  const historical = await harness(t, {
    observations: { captureObservationHandFloor: async () => 17 },
  });
  assert.equal(
    await raw(historical.socketPath, request(historical, 'hand_presence', { hand })),
    ''
  );
  let clock = 1000;
  const h = await harness(t, { options: { now: () => clock } });
  assert.ok(await raw(h.socketPath, request(h, 'hand_presence', { hand })));
  clock += 15000;
  assert.equal(await raw(h.socketPath, request(h, 'hand_facts', { hand })), '');
  assert.equal(h.failures.length, 1);
});

test('worker failure aborts an in-flight read and closes the private connection', async (t) => {
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const h = await harness(t, {
    observations: {
      schemaCatalogue: async () => {
        started();
        return new Promise(() => {});
      },
    },
  });
  const result = h.client().catalogue();
  await entered;
  h.db.emit('error', new Error('PRIVATE SQL AND CREDENTIAL MUST NOT ESCAPE'));
  await assert.rejects(result);
  await h.bridge.close();
  assert.ok(h.db.ended >= 1);
  assert.deepEqual(h.failures, ['OBSERVATION_DATABASE_FAILED']);
});

test('explicit server close makes subsequent clients fail without fallback', async (t) => {
  const h = await harness(t);
  const client = h.client();
  await h.bridge.close();
  await assert.rejects(client.catalogue());
  assert.equal(h.failures.length, 0);
  assert.ok(h.db.ended >= 1);
});

test('concurrent reads, replayed request IDs and invalid reply facts fail closed', async (t) => {
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const h = await harness(t, {
    observations: {
      schemaCatalogue: async () => {
        started();
        return new Promise(() => {});
      },
    },
  });
  const pending = raw(h.socketPath, request(h));
  await entered;
  assert.equal(await raw(h.socketPath, request(h)), '');
  assert.equal(await pending, '');
  const replay = await harness(t);
  const item = request(replay);
  assert.ok(await raw(replay.socketPath, item));
  assert.equal(await raw(replay.socketPath, item), '');
  const invalid = await harness(t, {
    observations: { observeHandFacts: async () => ({ ...facts, success: true }) },
  });
  await assert.rejects(invalid.client().handFacts(hand));
});

test('client rejects wrong control revision and socket/parent substitution', async (t) => {
  const h = await harness(t);
  assert.throws(() =>
    createObservationClient(h.descriptor, { version: 1, control_sha: 'c'.repeat(40) }, h.options)
  );
  await chmod(h.directory, 0o2770);
  await assert.rejects(h.client().catalogue());
  await chmod(h.directory, 0o2750);
});

const financial = { actor_index: 0, op_id: 'bounded-topup-01', hand_number: 17 };
function financialHarnessOptions(extra = {}) {
  const financialActors = [randomUUID(), randomUUID()];
  return {
    financialActors,
    observations: {
      observeFinancialFacts: async (_db, _table, actors, selection) => {
        assert.deepEqual(actors, financialActors);
        assert.deepEqual(selection, financial);
        return {
          actor_ids: actors,
          ...Object.fromEntries(Object.keys(protocol.FINANCIAL_SECTIONS).map((key) => [key, []])),
        };
      },
    },
    ...extra,
  };
}

test('financial reader uses trusted actors and refuses cross-client operation substitution', async (t) => {
  const h = await harness(t, financialHarnessOptions());
  const client = h.client();
  const result = await client.financialFacts(financial);
  assert.equal(result.actor_ids.length, 2);
  assert.deepEqual(await client.financialFacts(financial), result);
  const calls = h.db.calls.length;
  assert.equal(
    await raw(
      h.socketPath,
      request(h, 'financial_facts', {
        financial: { ...financial, op_id: 'substituted-01' },
      })
    ),
    ''
  );
  assert.equal(h.db.calls.length, calls, 'substitution never enters a database transaction');
  assert.equal(h.failures.length, 1);
  client.close();
});

test('financial reads require trusted actor binding and a newly dealt hand', async (t) => {
  const absent = await harness(t);
  await assert.rejects(absent.client().financialFacts(financial));
  const historical = await harness(
    t,
    financialHarnessOptions({
      observations: { captureObservationHandFloor: async () => 17 },
    })
  );
  await assert.rejects(historical.client().financialFacts(financial));
});

test('financial deadline is finite and cannot be renewed by a new observer client', async (t) => {
  let clock = 1000;
  const h = await harness(t, financialHarnessOptions({ options: { now: () => clock } }));
  assert.ok(await raw(h.socketPath, request(h, 'financial_facts', { financial })));
  clock += protocol.FINANCIAL_MS;
  const before = h.db.calls.length;
  assert.equal(await raw(h.socketPath, request(h, 'financial_facts', { financial })), '');
  assert.equal(h.db.calls.length, before);
  assert.equal(h.failures.length, 1);
});

test('financial client pins actor, key and hand independently of ordinary hand reads', async (t) => {
  for (const replacement of [
    { actor_index: 1 },
    { op_id: 'other-topup-02' },
    { hand_number: 18 },
  ]) {
    const h = await harness(t, financialHarnessOptions());
    const client = h.client();
    await client.financialFacts(financial);
    const before = h.db.calls.length;
    await assert.rejects(client.financialFacts({ ...financial, ...replacement }), /SUBSTITUTION/);
    assert.equal(h.db.calls.length, before);
  }
});
