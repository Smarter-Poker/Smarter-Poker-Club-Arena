import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cycleEvent,
  witnessCycle,
  cycleClock,
  ownPreactionExecuted,
  recordCycleEvent,
  clickCycleControlOnce,
} from './lightning-pilot-cycle.mjs';
const room = '11111111-1111-4111-8111-111111111111';
const history = '22222222-2222-4222-8222-222222222222';
const event = (type, extra = {}) =>
  JSON.stringify({ type: 'EVENT', tableId: room, payload: { type, hand_number: 7, ...extra } });
test('live producer showdown without payload timestamp uses sequenced envelope time only', () => {
  const live = {
    type: 'EVENT',
    tableId: room,
    seq: 8,
    ts: 101,
    payload: { type: 'showdown', table_id: room, hand_number: 7, results: [{ cards: ['SECRET'] }] },
  };
  assert.deepEqual(cycleEvent(JSON.stringify(live), room, 100), {
    handNumber: 7,
    kind: 'showdown',
  });
  for (const altered of [
    { ...live, seq: undefined },
    { ...live, seq: 0 },
    { ...live, seq: 1.5 },
    { ...live, ts: 99 },
    { ...live, ts: undefined },
    { ...live, payload: { ...live.payload, replayed: true } },
    { ...live, payload: { ...live.payload, timestamp: 99 } },
    { ...live, payload: { ...live.payload, timestamp: '101' } },
  ])
    assert.equal(cycleEvent(JSON.stringify(altered), room, 100), null);
  assert.equal(cycleEvent(event('showdown', { timestamp: 101, replayed: true }), room, 100), null);
});
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

test('partial browser failure retains bounded live phases and requested hand identity without qualifying controls', async () => {
  const handlers = {},
    socket = {},
    selectors = [];
  let closed = false,
    signedOut = false;
  const pin = {
    playerId: history,
    poolSessionId: room,
    clubId: 'e14bc9f7-736d-425f-8f2c-e78305ebac1d',
    clusterId: 'babb43f1-368e-406f-a97a-a0d5013648b2',
  };
  const page = {
    on: (name, callback) => {
      handlers[name] = callback;
    },
    goto: async () => {
      handlers.websocket({
        on: (name, callback) => {
          socket[name] = callback;
        },
      });
      socket.framesent({
        payload: JSON.stringify({ type: 'RENDER_ACK', tableId: room, hand_id: history }),
      });
      for (const type of ['player_action', 'showdown'])
        socket.framereceived({
          payload: JSON.stringify({
            type: 'EVENT',
            tableId: room,
            seq: 8,
            ts: Date.now(),
            payload: { type, hand_number: 7, action: 'bet', amount: 999, cards: ['SECRET'] },
          }),
        });
      // The app's own Time Bank request (no witness click in flight) is retained
      // apart and never counted as the witness's one request.
      handlers.request({
        method: () => 'POST',
        url: () => 'https://engine.smarter.poker/timebank',
        postDataJSON: () => ({ tableId: room }),
      });
      handlers.request({
        method: () => 'POST',
        url: () => 'https://engine.smarter.poker/preaction',
        postDataJSON: () => ({
          tableId: room,
          action: 'auto_check',
          handId: history,
          maxCallAmount: 999,
        }),
      });
    },
    waitForFunction: async () => {},
    locator: (selector) => {
      if (selector.includes('data-tabid'))
        return {
          waitFor: async () => {},
          count: async () => 1,
          isVisible: async () => true,
          tap: async () => {},
          click: async () => {},
          getAttribute: async () => 'true',
        };
      selectors.push(selector);
      return {
        getAttribute: async () => 'accepted',
        isVisible: async () => {
          throw new Error('SECRET_FAILURE');
        },
      };
    },
  };
  const client = {
    auth: {
      signOut: async () => {
        signedOut = true;
        return {};
      },
    },
  };
  const result = await witnessCycle({
    pin,
    timebank: true,
    openSession: async () => ({ client, session: {} }),
    chromium: {
      launch: async () => ({
        newContext: async () => ({ addInitScript: async () => {}, newPage: async () => page }),
        close: async () => {
          closed = true;
        },
      }),
    },
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.controlsQualified, false);
  assert.equal(result.preactionRequestHandId, history);
  assert.deepEqual(result.requests, { timebank: 0, preaction: 1 });
  assert.deepEqual(result.appRequests, { timebank: 1 });
  assert.deepEqual(result.foldWatch, { accepted: 0, refused: 0, unknown: 0 });
  assert.deepEqual(result.observedHands, [
    { handNumber: 7, betting: true, showdown: true, hand_complete: false, historyId: null },
  ]);
  assert.ok(
    selectors.some((selector) => selector.includes('title="Unlimited Lifetime VIP Time Banks"'))
  );
  assert.equal(result.cleanup, 'local_session_closed');
  assert.equal(closed && signedOut, true);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|999|cards|maxCallAmount/);
});

test('a disappearing optional control is clicked once with a bounded response and does not block the next observation', async () => {
  let clicks = 0;
  const budgets = [];
  const firstPage = {
    waitForResponse: async (_match, opts) => {
      budgets.push(opts.timeout);
      throw Object.assign(new Error('SECRET_SELECTOR'), { name: 'TimeoutError' });
    },
  };
  const firstControl = {
    click: async (opts) => {
      clicks++;
      budgets.push(opts.timeout);
      throw new Error('SECRET_DOM');
    },
  };
  assert.equal(
    await clickCycleControlOnce(
      firstPage,
      firstControl,
      () => true,
      () => 150000
    ),
    null
  );
  assert.equal(clicks, 1);
  assert.deepEqual(budgets, [5000, 2500]);
  const receipt = { ok: () => true };
  const secondPage = { waitForResponse: async () => receipt };
  const secondControl = {
    click: async () => {
      clicks++;
    },
  };
  assert.equal(
    await clickCycleControlOnce(
      secondPage,
      secondControl,
      () => true,
      () => 4000
    ),
    receipt
  );
  assert.equal(clicks, 2);
  const source = readFileSync(new URL('./lightning-pilot-cycle.mjs', import.meta.url), 'utf8');
  assert.match(source, /const response = await clickCycleControlOnce\(/);
  assert.match(
    source,
    /if \(!response\) \{\s*report\[key\] = 'click_or_response_unknown';\s*continue;/
  );
  assert.match(source, /report\.requests\.timebank - report\.staleRefusals\.timebank === 1/);
  assert.match(source, /report\.requests\.preaction - report\.staleRefusals\.preaction === 1/);
  // Only an ended-hand refusal is retried, once; any other refusal still stops.
  assert.match(
    source,
    /if \(!stale \|\| retried\.has\(key\)\) throw new Error\('Optional Action Refused'\)/
  );
  assert.match(source, /answer\?\.code === 'STALE_HAND'/);
  assert.match(source, /report.timebank === 'accepted'/);
});

test('a client-held turn is answered once per hand with the normal Fold & Watch, never a wager', () => {
  const src = readFileSync(new URL('./lightning-pilot-cycle.mjs', import.meta.url), 'utf8');
  assert.match(src, /getByTestId\('lightning-fold-watch'\)/);
  assert.match(src, /foldedHands\.has\(hand\)/);
  assert.match(src, /foldedHands\.add\(hand\)/);
  // The witness never reaches for a wagering control.
  assert.doesNotMatch(
    src,
    /lightning-(call|raise|bet)|getByRole\('button', \{ name: '(Call|Raise|Bet)/
  );
  // The pre-action is offered first; the Time Bank needs the player's own turn.
  assert.ok(src.indexOf("['preaction', preaction") < src.indexOf("'timebank',\n        timebank"));
});

test('an armed Time Bank turn waits for the bank before Fold & Watch; the pre-action gets a longer offer window', () => {
  const src = readFileSync(new URL('./lightning-pilot-cycle.mjs', import.meta.url), 'utf8');
  const watch = src.slice(src.indexOf('const watchOwnTurn'));
  assert.ok(
    watch.indexOf("report.timebank === 'accepted'") < watch.indexOf('foldedHands.add(hand)')
  );
  assert.match(watch, /!\(bankActivated && deadlineExtended\)/);
  assert.match(src, /key === 'preaction' \? 60000 : 20000/);
});

test('an unknown control acknowledgment records a fixed cause, never a message', async () => {
  const page = {
    waitForResponse: async () => {
      throw Object.assign(new Error('SECRET'), { name: 'TimeoutError' });
    },
  };
  for (const [err, cause] of [
    [new Error('Selected Pool Unverified'), 'selected_pool_unverified'],
    [Object.assign(new Error('x'), { name: 'TimeoutError' }), 'control_not_clickable'],
    [new Error('SECRET_DOM'), 'click_failed'],
  ]) {
    const why = {};
    const r = await clickCycleControlOnce(
      page,
      {
        click: async () => {
          throw err;
        },
      },
      () => false,
      () => 60000,
      why
    );
    assert.equal(r, null);
    assert.deepEqual(why, { click: cause, response: 'no_matching_response' });
  }
});

test('a click whose pointer is taken keeps only the blocking tag and class tokens', async () => {
  const page = {
    waitForResponse: async () => {
      throw Object.assign(new Error('x'), { name: 'TimeoutError' });
    },
  };
  const why = {};
  await clickCycleControlOnce(
    page,
    {
      click: async () => {
        throw Object.assign(
          new Error(
            'locator.click: Timeout 2500ms exceeded.\n  - <div id="secret" class="daily-bonus-sheet open">SECRET TEXT</div> intercepts pointer events\n  - retrying click action'
          ),
          { name: 'TimeoutError' }
        );
      },
    },
    () => false,
    () => 60000,
    why
  );
  assert.equal(why.click, 'control_not_clickable');
  assert.equal(why.reason, 'pointer_intercepted');
  assert.equal(why.interceptedBy, 'div.daily-bonus-sheet.open');
  assert.doesNotMatch(JSON.stringify(why), /SECRET|secret/);
});
