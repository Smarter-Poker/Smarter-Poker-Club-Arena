import test from 'node:test';
import assert from 'node:assert/strict';
import { collectReplayBatch } from './lightning-pilot-replay-batch.mjs';
const clusterId = 'babb43f1-368e-406f-a97a-a0d5013648b2';
const owner = '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
const clubId = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
function fixture(mode = '') {
  const calls = [];
  const row = (n) => ({
    hand_id: id(n),
    cluster_id: clusterId,
    lightning_instance_id: id(n + 10),
    hand_history_id: id(n + 20),
    formed_at: '2026-10-15T20:00:00Z',
    settled_at: '2026-10-15T20:01:00Z',
  });
  const rows = mode === 'empty' ? [] : [row(1), row(2)];
  const admin = {
    from(table) {
      const q = {};
      for (const method of ['select', 'eq', 'gte', 'lte', 'not', 'gt', 'order'])
        q[method] = (...a) => {
          calls.push([table, method, ...a]);
          return q;
        };
      q.maybeSingle = async () => ({
        data:
          table === 'cash_games'
            ? {
                id: clusterId,
                club_id: clubId,
                name: 'Lightning Pilot NLH Action 6',
                template_name: mode === 'classic' ? 'classic' : 'action',
                handedness: 6,
                sb: 0.01,
                bb: 0.02,
                variant: 'nlh',
                enabled: true,
                must_move: true,
                cluster_mode: 'must_move',
                lightning_enabled: false,
                ruleset_snapshot: {
                  template: 'action',
                  variant: 'nlh',
                  regular_ante: 'sb',
                  vpip_floor: 30,
                  vpip_window: 10,
                  bombs: { enabled: true, trigger: 'timed_15m', ante_bb: 2, boards: 2 },
                  options: { is_private: mode !== 'public' },
                },
              }
            : {
                id: clubId,
                name: 'Lightning Internal Pilot',
                owner_id: owner,
                is_public: false,
                requires_approval: true,
              },
      });
      q.limit = async (n) => ({
        data: mode === 'truncated' ? rows.slice(0, 1) : rows.slice(0, n),
        count: mode === 'no-count' ? null : rows.length,
        error: mode === 'read-error' ? {} : null,
      });
      return q;
    },
  };
  const player = {
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: mode === 'wrong-owner' ? id(99) : owner } } },
      }),
    },
    rpc: async (name, args) => {
      calls.push([name, args]);
      const h = rows.find((h) => h.hand_id === args.p_hand_id);
      return {
        error: mode === 'rpc-error' ? {} : null,
        data: {
          ok: true,
          cluster_id: clusterId,
          hand_id: h.hand_id,
          hand: {
            ...h,
            settled_at: '2026-10-15T20:01:00+00:00',
            lightning_instance_id: mode === 'mismatch' ? id(99) : h.lightning_instance_id,
          },
          replay: {
            hand_id: h.hand_id,
            cluster_id: clusterId,
            settled: true,
            ok: mode !== 'defect',
            defects: mode === 'defect' ? [{ code: 'conservation', cards: ['As'] }] : [],
          },
          access_token: 'SECRET',
          hole_cards: ['As'],
        },
      };
    },
  };
  return {
    calls,
    args: {
      admin,
      player,
      clusterId,
      from: '2026-10-15T19:00:00Z',
      to: '2026-10-15T21:00:00Z',
      maxBatch: 2,
    },
  };
}
test('full chosen page replays each actual hand and strips private payload; equal timestamps accept offset formatting', async () => {
  const f = fixture();
  const r = await collectReplayBatch(f.args);
  assert.equal(r.verdict, 'batch_passed');
  assert.equal(r.checked, 2);
  assert.equal(r.complete, true);
  assert.equal(f.calls.filter((x) => x[0] === 'fn_lightning_operator_hand_replay').length, 2);
  assert.equal(r.hands[0].conservation, 'passed');
  assert.doesNotMatch(JSON.stringify(r), /SECRET|hole_cards|As/);
  assert.ok(f.calls.some((x) => x[1] === 'select' && x[3]?.count === 'exact'));
});
test('partial page advertises continuation and explicit cursor reaches the actual query', async () => {
  const f = fixture();
  f.args.maxBatch = 1;
  const r = await collectReplayBatch(f.args);
  assert.equal(r.complete, false);
  assert.equal(r.nextCursor, id(1));
  assert.equal(r.remainingAtSelection, 2);
  const f2 = fixture('empty');
  f2.args.cursor = r.nextCursor;
  const r2 = await collectReplayBatch(f2.args);
  assert.ok(f2.calls.some((x) => x[1] === 'gt' && x[2] === 'hand_id' && x[3] === id(1)));
  assert.equal(r2.complete, true);
  assert.equal(r2.verdict, 'no_hands');
});
for (const mode of [
  'truncated',
  'no-count',
  'read-error',
  'rpc-error',
  'mismatch',
  'public',
  'wrong-owner',
])
  test(`${mode} is unknown and never complete`, async () => {
    const f = fixture(mode);
    const r = await collectReplayBatch(f.args);
    assert.equal(r.status, 'unknown');
    assert.equal(r.complete, false);
    assert.equal(r.nextCursor, null);
  });
test('actual conservation defect remains failed, compact and visible', async () => {
  const f = fixture('defect');
  const r = await collectReplayBatch(f.args);
  assert.equal(r.verdict, 'batch_failed');
  assert.equal(r.hands[0].conservation, 'failed');
  assert.deepEqual(r.hands[0].defects, ['conservation']);
  assert.doesNotMatch(JSON.stringify(r), /cards|SECRET/);
});
test('invalid bounds and nonpilot targets refuse before reads', async () => {
  for (const patch of [
    { maxBatch: 1001 },
    { maxBatch: 0 },
    { cursor: 'bad' },
    { clusterId: 'not-a-uuid' },
    { to: '2100-01-01T00:00:00Z' },
    { from: 'bad' },
  ]) {
    const f = fixture();
    Object.assign(f.args, patch);
    const r = await collectReplayBatch(f.args);
    assert.equal(r.errorCode, 'INVALID_REPLAY_SCOPE');
    assert.equal(f.calls.length, 0);
  }
});

test('Classic or arbitrary valid UUID is rejected before owner session inspection', async () => {
  for (const mode of ['classic', '']) {
    const f = fixture(mode);
    let authReads = 0;
    f.args.player.auth.getSession = async () => {
      authReads++;
      throw new Error();
    };
    if (mode === '') f.args.clusterId = id(99);
    const r = await collectReplayBatch(f.args);
    assert.equal(r.status, 'unknown');
    assert.equal(authReads, 0);
    assert.equal(f.calls.filter((x) => x[0] === 'fn_lightning_operator_hand_replay').length, 0);
  }
});
