import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cycleEvent,
  witnessCycle,
  cycleClock,
  ownPreactionExecuted,
  recordCycleEvent,
} from './lightning-pilot-cycle.mjs';
const room = '11111111-1111-4111-8111-111111111111';
const history = '22222222-2222-4222-8222-222222222222';
const event = (type, extra = {}) =>
  JSON.stringify({ type: 'EVENT', tableId: room, payload: { type, hand_number: 7, ...extra } });
test('recent bounded hand ring observes a qualifying hand after twelve early nonshowdowns', () => {
  const hands = new Map();
  for (let handNumber = 1; handNumber <= 20; handNumber++)
    recordCycleEvent(hands, { handNumber, kind: 'betting' }, 1);
  assert.equal(hands.size, 12);
  assert.equal(hands.has(1), true);
  for (const kind of ['betting', 'showdown', 'hand_complete', 'hand_history_saved'])
    recordCycleEvent(hands, { handNumber: 21, kind, historyId: history }, 1);
  assert.equal(hands.get(21).showdown, true);
  assert.equal(hands.get(21).historyId, history);
  for (let handNumber = 22; handNumber <= 50; handNumber++)
    recordCycleEvent(hands, { handNumber, kind: 'betting' }, 1);
  assert.equal(hands.size, 12);
  assert.equal(hands.has(1), true);
  assert.equal(hands.has(21), true);
  assert.equal(hands.has(50), true);
});
test('clock observation retains exact hand/context/deadline and applies only safe projected fields', () => {
  const before = cycleClock(
    JSON.stringify({
      type: 'SNAPSHOT',
      tableId: room,
      seq: 1,
      state: {
        hand_id: history,
        action_context: 'turn1',
        turn_deadline_ms: 1000,
        time_bank_active: false,
        cards: ['As'],
      },
    }),
    room
  );
  const after = cycleClock(
    JSON.stringify({
      type: 'DELTA',
      tableId: room,
      seq: 2,
      prev: 1,
      patch: [
        { op: 'replace', path: '/turn_deadline_ms', value: 21000 },
        { op: 'replace', path: '/time_bank_active', value: true },
        { op: 'replace', path: '/cards', value: ['Kh'] },
      ],
    }),
    room,
    before
  );
  assert.equal(after.turn_deadline_ms, 21000);
  assert.equal(after.hand_id, history);
  assert.equal(after.action_context, 'turn1');
  assert.equal(after.cards, undefined);
});
test('only persisted own pre_action check proves preaction execution; ordinary horse check does not', () => {
  assert.equal(
    ownPreactionExecuted(
      { actions: [{ userId: room, origin: 'pre_action', action: 'check' }] },
      room
    ),
    true
  );
  for (const actions of [
    null,
    [{ userId: room, origin: 'horse_policy', action: 'check' }],
    [{ userId: history, origin: 'pre_action', action: 'check' }],
    [{ userId: room, origin: 'pre_action', action: 'call' }],
  ])
    assert.equal(ownPreactionExecuted({ actions }, room), false);
});
test('actual wire events retain only bounded cycle evidence, never cards or action amounts', () => {
  assert.deepEqual(
    cycleEvent(event('player_action', { action: 'bet', amount: 20, cards: ['As'] }), room),
    { handNumber: 7, kind: 'betting' }
  );
  assert.deepEqual(cycleEvent(event('showdown', { results: [{ cards: ['As'] }] }), room), {
    handNumber: 7,
    kind: 'showdown',
  });
  assert.deepEqual(cycleEvent(event('hand_history_saved', { hand_id: history }), room), {
    handNumber: 7,
    kind: 'hand_history_saved',
    historyId: history,
  });
  for (const input of [
    'invalid',
    event('player_action', { action: 'fold' }),
    event('hand_history_saved', { hand_id: 'bad' }),
    event('hand_complete', { hand_number: -1 }),
  ])
    assert.equal(cycleEvent(input, room), null);
  assert.equal(cycleEvent(event('showdown'), history), null);
  assert.equal(cycleEvent(event('showdown', { timestamp: 99 }), room, 100), null);
  assert.equal(cycleEvent(event('showdown'), room, 100), null);
});
test('contracts bind actual event producer, history write and optional normal UI doors', () => {
  const src = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
  const host = src('server/src/lightning/LightningHandHost.ts');
  assert.match(host, /hub.emitEvent\(room, \{ \.\.\.frame, table_id: room \}\)/);
  for (const kind of ['hand_complete', 'hand_history_saved'])
    assert.ok(host.includes("type: '" + kind + "'"));
  assert.match(host, /hand_id: out.value.handHistoryId/);
  assert.match(host, /\.\.\.\(event.origin \? \{ origin: event.origin \} : \{\}\)/);
  assert.match(host, /actions: this.actions/);
  assert.match(host, /'pre_action',/);
  assert.match(
    src('supabase/migrations/20260307_hand_rake_history_missing_rpcs.sql'),
    /ADD COLUMN IF NOT EXISTS actions JSONB/
  );
  assert.match(
    src(
      'supabase/migrations/20260906113554_the_atomic_hand_insert_lets_the_defaults_apply_and_proves_it.sql'
    ),
    /jsonb_populate_record\(null::public.hand_history, \$1\)/
  );
  const frames = src('server/src/engine/presentation/handEventFrames.ts');
  for (const kind of ['player_action', 'showdown'])
    assert.ok(frames.includes("type: '" + kind + "'"));
  assert.match(
    src('server/src/transport/TableStateHub.ts'),
    /type: 'EVENT', tableId, seq, ts: Date.now\(\), payload/
  );
  const page = src('src/pages/TablePage.tsx');
  assert.match(
    page,
    /title=\{timeBankUnlimited \? 'Unlimited Lifetime VIP Time Banks' : 'Time Bank'\}/
  );
  assert.match(page, /onClick=\{handleActivateTimeBank\}/);
  assert.match(src('src/components/table/PreActionBar.tsx'), /pre-action-btn check/);
  assert.match(host, /if \(handId !== this.handId\)/);
  const api = src('src/services/GameServerAPI.ts');
  assert.match(api, /handId \? \{ tableId, action, maxCallAmount, handId \}/);
});
test('invalid scope and unbounded durations refuse before authentication or browser effects', async () => {
  await assert.rejects(witnessCycle({ pin: {} }));
  const pin = {
    playerId: history,
    poolSessionId: room,
    clubId: 'e14bc9f7-736d-425f-8f2c-e78305ebac1d',
    clusterId: 'babb43f1-368e-406f-a97a-a0d5013648b2',
  };
  for (const timeoutMs of [0, 240001, NaN]) await assert.rejects(witnessCycle({ pin, timeoutMs }));
});

test('partial authentication is owned inside cleanup and normal fetch is deadline bounded', async () => {
  const signouts = [];
  let boundedSignal = false;
  const pin = {
    playerId: history,
    poolSessionId: room,
    clubId: 'e14bc9f7-736d-425f-8f2c-e78305ebac1d',
    clusterId: 'babb43f1-368e-406f-a97a-a0d5013648b2',
  };
  const r = await witnessCycle({
    pin,
    createClient: (_base, _key, options) => ({
      options,
      auth: {
        signOut: async (value) => {
          signouts.push(value);
          return {};
        },
      },
    }),
    openSession: async (_admin, factory) => {
      const client = factory('https://example.invalid', 'public', {
        global: {
          fetch: async (_input, init) => {
            boundedSignal = init.signal instanceof AbortSignal;
            return {};
          },
        },
      });
      await client.options.global.fetch('https://example.invalid');
      throw new Error('PRIVATE_AUTH_ERROR');
    },
  });
  assert.equal(r.status, 'unknown');
  assert.equal(r.subphase, 'authentication');
  assert.equal(r.cleanup, 'local_session_closed');
  assert.equal(boundedSignal, true);
  assert.deepEqual(signouts, [{ scope: 'local' }]);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_AUTH_ERROR/);
});
