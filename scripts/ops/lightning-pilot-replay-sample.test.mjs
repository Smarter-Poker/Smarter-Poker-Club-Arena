import test from 'node:test';
import assert from 'node:assert/strict';
import { collectReplaySample } from './lightning-pilot-replay-sample.mjs';
const clusterId = 'babb43f1-368e-406f-a97a-a0d5013648b2';
const id = '00000000-0000-4000-8000-000000000001';
function fixture(mode) {
  const calls = [];
  const row = {
    hand_id: id,
    cluster_id: clusterId,
    hand_history_id: id,
    settled_at: '2026-10-15T20:20:00Z',
  };
  const q = {
    select: (...a) => {
      calls.push(['select', ...a]);
      return q;
    },
    eq: (...a) => {
      calls.push(['eq', ...a]);
      return q;
    },
    gte: () => q,
    lte: () => q,
    not: () => q,
    order: () => q,
    limit: (n) => {
      calls.push(['limit', n]);
      return Promise.resolve({
        data: mode === 'empty' ? [] : [row],
        error: mode === 'read-error' ? { code: 'READ_FAILED' } : null,
      });
    },
  };
  const rpc = async (name, args) => {
    calls.push([name, args]);
    const hand = mode === 'mismatch' ? clusterId : id;
    return {
      data: {
        ok: true,
        cluster_id: clusterId,
        hand_id: hand,
        hand: row,
        replay: {
          ok: mode !== 'defect',
          settled: true,
          hand_id: hand,
          cluster_id: clusterId,
          defects: mode === 'defect' ? [{ code: 'receipt_disagrees', private: 'SECRET' }] : [],
        },
        hole_cards: ['As'],
        access_token: 'SECRET',
      },
      error: mode === 'rpc-error' ? { code: 'REFUSED' } : null,
    };
  };
  return {
    calls,
    args: {
      admin: { from: () => q },
      player: { rpc },
      clusterId,
      from: '2026-10-15T18:14:55Z',
      to: '2026-10-15T21:00:00Z',
    },
  };
}
test('actual replay sample is bounded, deduplicated and strips arbitrary fields', async () => {
  const f = fixture();
  const r = await collectReplaySample(f.args);
  assert.equal(r.status, 'known');
  assert.equal(r.data.checked, 1);
  assert.equal(r.data.passed, 1);
  assert.equal(r.data.verdict, 'sample_passed');
  assert.equal(f.calls.filter((c) => c[0] === 'fn_lightning_operator_hand_replay').length, 1);
  assert.deepEqual(
    f.calls.filter((c) => c[0] === 'limit').map((c) => c[1]),
    [3, 3]
  );
  assert.ok(f.calls.some((c) => c[0] === 'eq' && c[1] === 'cluster_id' && c[2] === clusterId));
  assert.doesNotMatch(JSON.stringify(r), /SECRET|hole_cards/);
});
for (const mode of ['read-error', 'rpc-error', 'mismatch'])
  test(`${mode} stays unknown`, async () => {
    const f = fixture(mode);
    const r = await collectReplaySample(f.args);
    assert.equal(r.status, 'unknown');
  });
test('a real defect remains failed and only defect codes are retained', async () => {
  const f = fixture('defect');
  const r = await collectReplaySample(f.args);
  assert.equal(r.data.verdict, 'sample_failed');
  assert.deepEqual(r.data.hands[0].defects, ['receipt_disagrees']);
  assert.doesNotMatch(JSON.stringify(r), /SECRET/);
});
test('no hand is missing evidence', async () => {
  const f = fixture('empty');
  const r = await collectReplaySample(f.args);
  assert.equal(r.data.verdict, 'no_samples');
  assert.equal(r.data.checked, 0);
});
