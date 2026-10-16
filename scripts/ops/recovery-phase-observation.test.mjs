import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRecoveryPhase,
  phaseReconnectEvidence,
  captureRecoveryPhase,
} from './recovery-phase-observation.mjs';
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const pin = {
  clusterId: 'babb43f1-368e-406f-a97a-a0d5013648b2',
  playerId: id(1),
  poolSessionId: id(2),
};
const own = { pool_session_id: pin.poolSessionId, state: 'active', in_hand: true, hand_id: id(3) };
function sample(state = 'dealing') {
  return {
    pin,
    before: own,
    after: own,
    reservations: [
      {
        id: id(4),
        cluster_id: pin.clusterId,
        cluster_epoch: 2,
        player_id: pin.playerId,
        state: 'committed',
        lightning_instance_id: id(5),
        pool_slot_id: id(6),
      },
    ],
    slots: [
      {
        id: id(6),
        pool_session_id: pin.poolSessionId,
        cluster_id: pin.clusterId,
        player_id: pin.playerId,
        closed_at: null,
      },
    ],
    instances: [
      {
        id: id(5),
        cluster_id: pin.clusterId,
        cluster_epoch: 2,
        state,
        hand_id: id(3),
        started_at: '2026-10-16T12:00:00Z',
      },
    ],
  };
}
test('nonnull own hand never implies dealing without actual dealing instance', () => {
  for (const s of ['forming', 'reserved', 'settling', 'completed'])
    assert.equal(classifyRecoveryPhase(sample(s)).status, 'unknown');
  assert.equal(classifyRecoveryPhase(sample()).phase, 'dealing');
});
test('idle requires own not-in-hand and no active reservation', () => {
  const f = sample();
  f.before = f.after = { ...own, in_hand: false, hand_id: null };
  f.reservations = [];
  f.instances = [];
  assert.equal(classifyRecoveryPhase(f).phase, 'idle');
  f.before = own;
  assert.equal(classifyRecoveryPhase(f).status, 'unknown');
});
test('forming committed reservation is distinct from idle; pending/mismatched identity unknown', () => {
  const f = sample('forming');
  f.before = f.after = { ...own, hand_id: null };
  assert.equal(classifyRecoveryPhase(f).phase, 'reservation');
  f.reservations[0].state = 'pending';
  assert.equal(classifyRecoveryPhase(f).status, 'unknown');
  f.reservations[0].state = 'committed';
  f.reservations[0].player_id = id(9);
  assert.equal(classifyRecoveryPhase(f).status, 'unknown');
});
test('changed own state across reads and missing started timestamp reject claims', () => {
  const f = sample();
  f.after = { ...own, hand_id: id(9) };
  assert.equal(classifyRecoveryPhase(f).status, 'unknown');
  f.after = own;
  f.instances[0].started_at = null;
  assert.equal(classifyRecoveryPhase(f).status, 'unknown');
});
test('reservation belonging to a different or closed pool slot never proves this session phase', () => {
  const f = sample();
  f.slots[0].pool_session_id = id(99);
  assert.equal(classifyRecoveryPhase(f).status, 'unknown');
  f.slots[0].pool_session_id = pin.poolSessionId;
  f.slots[0].closed_at = '2026-10-16T12:00:00Z';
  assert.equal(classifyRecoveryPhase(f).status, 'unknown');
});
test('timing bracket rejects stale pre-disconnect reads and unknown phases', () => {
  const b = {
    status: 'observed',
    phase: 'dealing',
    ...pin,
    handId: id(3),
    startedAt: 100,
    endedAt: 110,
  };
  const a = { ...b, startedAt: 200, endedAt: 210 };
  const args = { before: b, after: a, offlineStartedAt: 120, onlineStartedAt: 190 };
  assert.equal(phaseReconnectEvidence(args).status, 'observed');
  assert.equal(
    phaseReconnectEvidence({ ...args, offlineStartedAt: 400, onlineStartedAt: 410 }).status,
    'unknown'
  );
  assert.equal(
    phaseReconnectEvidence({ ...args, before: { ...b, status: 'unknown' } }).status,
    'unknown'
  );
  assert.equal(phaseReconnectEvidence({ ...args, after: { ...a, handId: id(9) } }).sameHand, false);
});
test('invalid scope refuses before any database read', async () => {
  const r = await captureRecoveryPhase({
    pin: {},
    remaining: () => 1000,
    player: {
      rpc() {
        throw Error('must not read');
      },
    },
    admin: {},
  });
  assert.equal(r.status, 'unknown');
});
test('capture adapter traverses real own RPC and scoped reservation slot instance contracts', async () => {
  const f = sample();
  const calls = [];
  let rpcReads = 0;
  const player = {
    rpc: async (name, args) => {
      calls.push(['rpc', name, args]);
      rpcReads++;
      return { data: { ...own, stack: 999, private: 'SECRET' }, error: null };
    },
  };
  const tables = {
    lightning_reservation: f.reservations,
    lightning_pool_slot: f.slots[0],
    lightning_instance: f.instances[0],
  };
  const admin = {
    from(table) {
      calls.push(['from', table]);
      const q = {};
      for (const method of ['select', 'eq', 'in'])
        q[method] = (...args) => {
          calls.push([table, method, ...args]);
          return q;
        };
      q.limit = async (n) => {
        calls.push([table, 'limit', n]);
        return { data: tables[table], count: 1, error: null };
      };
      q.maybeSingle = async () => ({ data: tables[table], error: null });
      return q;
    },
  };
  let clockReads = 0,
    deadlineReads = 0;
  const result = await captureRecoveryPhase({
    admin,
    player,
    pin,
    remaining: () => {
      deadlineReads++;
      return 1000;
    },
    now: () => (clockReads++ ? 120 : 100),
  });
  assert.equal(result.status, 'observed');
  assert.equal(result.phase, 'dealing');
  assert.equal(result.handId, own.hand_id);
  assert.equal(result.poolSessionId, pin.poolSessionId);
  assert.equal(result.playerId, pin.playerId);
  assert.equal(result.instanceId, id(5));
  assert.equal(result.startedAt, 100);
  assert.equal(result.endedAt, 120);
  assert.equal(rpcReads, 2);
  assert.ok(deadlineReads >= 5);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'rpc'),
    [
      ['rpc', 'fn_lightning_reconnect_state', { p_cluster_id: pin.clusterId }],
      ['rpc', 'fn_lightning_reconnect_state', { p_cluster_id: pin.clusterId }],
    ]
  );
  assert.ok(
    calls.some(
      (c) =>
        c[0] === 'lightning_reservation' &&
        c[1] === 'select' &&
        c[2].includes('pool_slot_id') &&
        c[3].count === 'exact'
    )
  );
  for (const [column, value] of [
    ['cluster_id', pin.clusterId],
    ['player_id', pin.playerId],
  ])
    assert.ok(
      calls.some(
        (c) =>
          c[0] === 'lightning_reservation' && c[1] === 'eq' && c[2] === column && c[3] === value
      )
    );
  assert.ok(
    calls.some(
      (c) =>
        c[0] === 'lightning_reservation' &&
        c[1] === 'in' &&
        c[2] === 'state' &&
        JSON.stringify(c[3]) === JSON.stringify(['pending', 'committed'])
    )
  );
  assert.ok(
    calls.some(
      (c) => c[0] === 'lightning_pool_slot' && c[1] === 'eq' && c[2] === 'id' && c[3] === id(6)
    )
  );
  assert.ok(
    calls.some(
      (c) => c[0] === 'lightning_instance' && c[1] === 'eq' && c[2] === 'id' && c[3] === id(5)
    )
  );
  assert.doesNotMatch(JSON.stringify(result), /SECRET|stack|private/);
});
