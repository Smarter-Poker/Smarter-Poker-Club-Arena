import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  witnessAdmission,
  ADMISSION_PLAYER,
  admissionReceiptMatches,
  readAdmissionPool,
  entryDoorInPage,
  joinRefusalCode,
  uiFailureClass,
  ENTRY_DOORS,
  ENTRY_LAYERS,
} from './lightning-pilot-admission.mjs';
const CLUB = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d',
  CLUSTER = 'babb43f1-368e-406f-a97a-a0d5013648b2';
const TABLE = '10000000-0000-4000-8000-000000000001',
  POOL = '10000000-0000-4000-8000-000000000002',
  CASH = '10000000-0000-4000-8000-000000000003',
  OP = '10000000-0000-4000-8000-000000000004';
const SECRET = 'NEVER_RETAIN_SESSION_OR_CARD';
const payload = {
  p_user_id: ADMISSION_PLAYER,
  p_table_id: TABLE,
  p_club_id: CLUB,
  p_seat_number: 1,
  p_amount: 2,
  p_auto_rebuy: false,
  p_idempotency_key: OP,
};
const receipt = {
  status: 'confirmed',
  request: {
    door: 'atomic_table_buyin',
    user_id: ADMISSION_PLAYER,
    table_id: TABLE,
    club_id: CLUB,
    seat_number: 1,
    amount: 2,
    auto_rebuy: false,
  },
};
const pin = { clubId: CLUB, clusterId: CLUSTER, playerId: ADMISSION_PLAYER };
function fixture({
  preexisting = false,
  receiptValue = receipt,
  poolAfter = true,
  reply = true,
  wrongIdentity = false,
  gate = 'accepted',
  joinAction = 'seat',
  needsChair = false,
  joinedExistingPool = false,
  // What the settled entry offers; an answered layer reveals the next one.
  doors = [{ door: 'join_lightning', layer: 'clear' }],
  joinRefusal = null,
  // A layer control whose tap fails, and the error it fails with.
  layerFailure = null,
  // The intent the normal buy-in actually sends.
  buyPayload = payload,
} = {}) {
  const actions = [],
    cleanup = [],
    rpc = [],
    events = new Map();
  const observed = () => ({
    route: 'entry',
    profileGate: 'complete',
    settled: true,
    ...doors[0],
  });
  const layerDialog = (name) => ({
    first: () => layerDialog(name),
    waitFor: async () => {},
    getByRole: (role, opts) => {
      if (name === 'daily_bonus')
        assert.equal(opts.name, 'Close', 'Actual daily bonus secondary plate has aria-label Close');
      const label = name === 'daily_bonus' ? 'Not Now' : opts.name;
      const control = {
        filter: (criteria) => {
          assert.equal(criteria.hasText, 'Not Now');
          return control;
        },
        click: async () => {
          if (layerFailure?.control === label) throw layerFailure.error;
          actions.push(`${name}:${label}`);
          if ((label === 'Enter Poker Arena' || label === 'Not Now') && doors.length > 1)
            doors.shift();
        },
        getAttribute: async () => 'true',
      };
      return control;
    },
  });
  const request = (name) => ({
    method: () => 'POST',
    url: () => `https://example.invalid/rest/v1/rpc/${name}`,
    postDataJSON: () => buyPayload,
  });
  const buyResponse = {
    request: () => request('atomic_table_buyin'),
    json: async () => ({ ok: true, token: SECRET }),
  };
  const dialog = {
    isVisible: async () => !needsChair,
    waitFor: async () => {},
    getByRole: (_role, opts) => ({
      click: async () => {
        assert.equal(opts.name, 'Buy Chips');
        actions.push('buy');
        events.get('request')?.(request('atomic_table_buyin'));
      },
    }),
  };
  const page = {
    goto: async () => {},
    waitForURL: async (predicate) =>
      assert.equal(predicate(new URL(`https://smarter.poker/hub/club-arena/table/${TABLE}`)), true),
    waitForFunction: async () => {},
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      assert.equal(fn, entryDoorInPage);
      assert.equal(arg.clusterId, CLUSTER);
      return observed();
    },
    locator: (selector) =>
      selector.includes('club-arena-welcome-title')
        ? layerDialog('welcome')
        : selector.includes('dbs-title')
          ? layerDialog('daily_bonus')
          : selector.includes(':visible')
            ? {
                first: () => ({
                  click: async () => {
                    actions.push('chair');
                    needsChair = false;
                  },
                }),
              }
            : { getAttribute: async () => gate },
    getByTestId: (id) => {
      assert.equal(id, 'lightning-entry');
      return {
        getByRole: (_r, o) => ({
          click: async () => {
            assert.equal(o.name, 'Join Lightning');
            // A tap on an obstructed door never reaches the button.
            const now = doors[0];
            if (now.door !== 'join_lightning' || now.layer !== 'clear')
              throw new Error('intercepts pointer events');
            actions.push('join');
          },
        }),
      };
    },
    getByRole: (_role, opts) => {
      assert.equal(opts.name, 'Buy-In');
      return dialog;
    },
    on: (n, fn) => events.set(n, fn),
    off: (n) => events.delete(n),
    waitForResponse: async (predicate) => {
      const join = {
        request: () => request('fn_cash_game_join'),
        ok: () => !joinRefusal,
        json: async () =>
          joinRefusal
            ? { code: 'P0001', message: joinRefusal }
            : { ok: true, action: joinAction, table_id: TABLE },
      };
      if (predicate(join)) {
        // The join reply exists only once the door was actually tapped.
        await new Promise((resolve) => setImmediate(resolve));
        if (!actions.includes('join')) throw new Error('Timeout');
        return join;
      }
      assert.equal(predicate(buyResponse), true);
      if (!reply) throw new Error(SECRET);
      return buyResponse;
    },
  };
  const user = { id: ADMISSION_PLAYER, email: 'samantha@bot.smarter.poker' };
  const client = {
    auth: {
      verifyOtp: async () => ({ data: { user, session: { user, access_token: SECRET } } }),
      getUser: async () => ({ data: { user: wrongIdentity ? { id: POOL } : user } }),
      signOut: async (o) => {
        cleanup.push(o);
        return {};
      },
    },
    rpc: (name, args) => {
      rpc.push([name, args]);
      return {
        then: (resolve, reject) => Promise.resolve({ data: receiptValue }).then(resolve, reject),
      };
    },
  };
  const context = {
    addInitScript: async () => {},
    newPage: async () => page,
    close: async () => cleanup.push('context'),
  };
  const args = {
    admin: {
      auth: {
        admin: {
          getUserById: async () => ({ data: { user } }),
          generateLink: async () => ({ data: { user, properties: { hashed_token: SECRET } } }),
        },
      },
    },
    createClient: () => client,
    chromium: {
      launch: async () => ({
        newContext: async () => context,
        close: async () => cleanup.push('browser'),
      }),
    },
    url: 'https://example.invalid',
    pin,
    entryStableMs: 0,
    entrySettleMs: 0,
    validateScope: async () => 200,
    readOwnPool: async () => {
      return preexisting ||
        (joinedExistingPool && actions.includes('join')) ||
        (poolAfter && actions.includes('buy'))
        ? { poolSessionId: POOL, cashPlayerSessionId: CASH }
        : null;
    },
  };
  return { args, actions, cleanup, rpc };
}
test('normal UI once joins and buys, proves exact durable receipt and actual own pool, then keeps session through callback', async () => {
  const f = fixture();
  let callback = false;
  const r = await witnessAdmission({
    ...f.args,
    withAdmittedSession: async ({ pin: actual, remaining }) => {
      callback = true;
      assert.equal(actual.poolSessionId, POOL);
      assert.equal(f.cleanup.length, 0);
      assert.ok(remaining() > 0 && remaining() <= 220000);
      return { status: 'observed' };
    },
  });
  assert.equal(callback, true);
  assert.equal(r.status, 'observed');
  assert.equal(r.admissionOutcome, 'admitted');
  assert.deepEqual(f.actions, ['join', 'buy']);
  assert.deepEqual(f.rpc, [
    ['fn_ca_cash_buyin_receipt', { p_idempotency_key: OP, p_table_id: TABLE }],
  ]);
  assert.equal(r.buyIn.receipt, 'confirmed_exact_intent');
  assert.equal(r.buyIn.requestId, OP);
  assert.equal(r.pool.cashPlayerSessionId, CASH);
  assert.equal(r.cleanup, 'local_session_and_browser_closed');
  assert.deepEqual(f.cleanup.at(-1), { scope: 'local' });
  assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
});
test('preexisting own pool resumes read-only with no second join or buy-in', async () => {
  const f = fixture({ preexisting: true });
  const r = await witnessAdmission(f.args);
  assert.equal(r.status, 'observed');
  assert.equal(r.admissionOutcome, 'read_only_resume');
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.rpc, []);
});
test('unknown response reconciles once using exact receipt and persisted pool; unconfirmed or missing pool stays unknown without retry', async () => {
  for (const options of [
    { reply: false },
    { receiptValue: { status: 'unconfirmed' } },
    { poolAfter: false },
  ]) {
    const f = fixture(options);
    const r = await witnessAdmission(f.args);
    assert.equal(r.status, options.reply === false ? 'observed' : 'unknown');
    assert.deepEqual(f.actions, ['join', 'buy']);
    assert.equal(f.rpc.length, 1);
    assert.equal(r.cleanup, 'local_session_and_browser_closed');
    assert.deepEqual(f.cleanup.at(-1), { scope: 'local' });
    assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
  }
});
test('wrong identities and callback failure clean local session and never duplicate actions', async () => {
  const f = fixture({ wrongIdentity: true });
  const r = await witnessAdmission(f.args);
  assert.equal(r.status, 'unknown');
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.cleanup, [{ scope: 'local' }]);
  const g = fixture();
  const result = await witnessAdmission({
    ...g.args,
    withAdmittedSession: async () => {
      throw new Error(SECRET);
    },
  });
  assert.equal(result.status, 'unknown');
  assert.deepEqual(g.actions, ['join', 'buy']);
  assert.equal(result.cleanup, 'local_session_and_browser_closed');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
});
test('scope and funded active member preconditions refuse before authentication', async () => {
  let auth = 0;
  for (const overrides of [
    { pin: { ...pin, playerId: POOL } },
    { acceptTerms: 'true' },
    { timeoutMs: 240001 },
  ]) {
    const f = fixture();
    f.args.admin.auth.admin.getUserById = async () => {
      auth++;
      throw new Error();
    };
    const r = await witnessAdmission({ ...f.args, ...overrides });
    assert.equal(r.status, 'unknown');
  }
  assert.equal(auth, 0);
  const f = fixture();
  delete f.args.validateScope;
  f.args.admin.from = (table) => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({
        data:
          table === 'clubs'
            ? {
                id: CLUB,
                owner_id: '2d1cd6c3-5700-4af9-a271-d4863fdab20d',
                name: 'Lightning Internal Pilot',
                is_public: false,
                requires_approval: true,
              }
            : table === 'cash_games'
              ? {
                  id: CLUSTER,
                  club_id: CLUB,
                  name: 'Lightning Pilot NLH Action 6',
                  template_name: 'action',
                  handedness: 6,
                  sb: 0.01,
                  bb: 0.02,
                  variant: 'nlh',
                  enabled: true,
                  must_move: true,
                  cluster_mode: 'lightning',
                  lightning_enabled: true,
                  ruleset_snapshot: {
                    template: 'action',
                    variant: 'nlh',
                    regular_ante: 'sb',
                    vpip_floor: 30,
                    vpip_window: 10,
                    bombs: { enabled: true, trigger: 'timed_20m', ante_bb: 2, boards: 2 },
                    options: { is_private: true },
                  },
                }
              : table === 'profiles'
                ? { id: ADMISSION_PLAYER, is_horse: true, status: 'active' }
                : { user_id: ADMISSION_PLAYER, status: 'pending', role: 'player', chip_balance: 0 },
      }),
    };
    return q;
  };
  const result = await witnessAdmission(f.args);
  assert.equal(result.phase, 'scope');
  assert.equal(result.status, 'unknown');
  assert.deepEqual(f.cleanup, []);
});
test('receipt exact identity/amount/seat/counterparty matches maintained normal buy-in producer', () => {
  assert.equal(admissionReceiptMatches(payload, receipt), true);
  for (const patch of [
    { amount: 3 },
    { user_id: POOL },
    { club_id: POOL },
    { seat_number: 2 },
    { door: 'other' },
  ])
    assert.equal(
      admissionReceiptMatches(payload, { ...receipt, request: { ...receipt.request, ...patch } }),
      false
    );
  const modal = readFileSync(
    new URL('../../src/components/table/BuyInModal.tsx', import.meta.url),
    'utf8'
  );
  assert.match(modal, /<span>Buy-In<\/span>/);
  assert.match(modal, /'Buy Chips'/);
  const entry = readFileSync(
    new URL('../../src/pages/LightningEntryPage.tsx', import.meta.url),
    'utf8'
  );
  assert.match(entry, /data-testid="lightning-entry"/);
  assert.match(entry, /joinCashGame\(clusterId\)/);
  const pageSource = readFileSync(
    new URL('../../src/pages/TablePage.tsx', import.meta.url),
    'utf8'
  );
  assert.match(pageSource, /autoBuyInFiredRef/);
  assert.match(pageSource, /handleSeatClick\(openIdx \+ 1\)/);
  const helperSource = readFileSync(
    new URL('./lightning-pilot-admission.mjs', import.meta.url),
    'utf8'
  );
  assert.match(helperSource, /getClientRects/);
  assert.match(helperSource, /joined\.seat_number/);
  const recovery = readFileSync(
    new URL('../../src/services/CashBuyInRecovery.ts', import.meta.url),
    'utf8'
  );
  for (const field of ['user_id', 'table_id', 'seat_number', 'amount', 'auto_rebuy', 'club_id'])
    assert.ok(recovery.includes(`r.${field} === p.p_${field}`));
});

test('unaccepted default consent and a waitlisted join never purchase or retry', async () => {
  const f = fixture({ gate: 'not_accepted' });
  const declined = await witnessAdmission(f.args);
  assert.equal(declined.status, 'unknown');
  assert.equal(declined.phase, 'consent');
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.cleanup.at(-1), { scope: 'local' });
  const g = fixture({ joinAction: 'waitlisted', poolAfter: false });
  const waitlisted = await witnessAdmission(g.args);
  assert.equal(waitlisted.status, 'unknown');
  assert.equal(waitlisted.join.outcome, 'waitlisted');
  assert.deepEqual(g.actions, ['join']);
  assert.deepEqual(g.rpc, []);
});

test('actual table-scoped cash session is bound through the owned anchor and cluster', async () => {
  const SEAT = '10000000-0000-4000-8000-000000000005';
  const baseline = {
    lightning_pool_session: [
      {
        id: POOL,
        cluster_id: CLUSTER,
        player_id: ADMISSION_PLAYER,
        state: 'active',
        exited_at: null,
        cash_player_session_id: CASH,
        anchor_seat_id: SEAT,
      },
    ],
    table_seats: {
      id: SEAT,
      user_id: ADMISSION_PLAYER,
      club_id: CLUB,
      table_id: TABLE,
      left_at: null,
    },
    tables: { id: TABLE, cluster_id: CLUSTER },
    cash_player_session: {
      id: CASH,
      player_id: ADMISSION_PLAYER,
      club_id: CLUB,
      scope_type: 'table',
      scope_id: TABLE,
      table_id: TABLE,
      cluster_id: CLUSTER,
      closed_at: null,
    },
  };
  const make = (patch = {}) => ({
    from: (table) => {
      const q = {
        select: (fields) => {
          if (table === 'cash_player_session') {
            assert.ok(fields.includes('cluster_id'));
            assert.ok(fields.includes('table_id'));
          }
          return q;
        },
        eq: (key, value) => {
          if (table === 'table_seats') assert.deepEqual([key, value], ['id', SEAT]);
          return q;
        },
        is: () => q,
        maybeSingle: async () => ({ data: patch[table] ?? baseline[table] }),
        then: (resolve, reject) =>
          Promise.resolve({ data: patch[table] ?? baseline[table] }).then(resolve, reject),
      };
      return q;
    },
  });
  assert.deepEqual(await readAdmissionPool(make(), pin), {
    poolSessionId: POOL,
    cashPlayerSessionId: CASH,
  });
  for (const patch of [
    { cash_player_session: { ...baseline.cash_player_session, cluster_id: POOL } },
    {
      cash_player_session: {
        ...baseline.cash_player_session,
        scope_type: 'cluster',
        scope_id: CLUSTER,
      },
    },
    { table_seats: { ...baseline.table_seats, user_id: POOL } },
    { tables: { ...baseline.tables, cluster_id: POOL } },
    { table_seats: { ...baseline.table_seats, left_at: '2026-10-17' } },
  ])
    await assert.rejects(readAdmissionPool(make(patch), pin));
});

test('entry without auto-open waits for actual offered chair and taps once before normal purchase', async () => {
  const f = fixture({ needsChair: true });
  const report = await witnessAdmission(f.args);
  assert.equal(report.status, 'observed');
  assert.deepEqual(f.actions, ['join', 'chair', 'buy']);
});

test('session injection is origin-pinned and request identity is captured before waiting for its reply', () => {
  const source = readFileSync(new URL('./lightning-pilot-admission.mjs', import.meta.url), 'utf8');
  assert.match(source, /location.origin !== 'https:\/\/smarter.poker'/);
  const capture = source.slice(
    source.indexOf('const capture ='),
    source.indexOf("page.on('request', capture)")
  );
  assert.match(capture, /report.buyIn.requestId = payload.p_idempotency_key/);
  assert.ok(source.indexOf("page.on('request', capture)") < source.indexOf('const bought ='));
});

test('a pool lost after the acknowledged buy-in cannot reach the player callback', async () => {
  const f = fixture();
  let readsAfterBuy = 0;
  f.args.readOwnPool = async () => {
    if (!f.actions.includes('buy')) return null;
    readsAfterBuy += 1;
    return readsAfterBuy === 1 ? { poolSessionId: POOL, cashPlayerSessionId: CASH } : null;
  };
  const r = await witnessAdmission({
    ...f.args,
    withAdmittedSession: async () => assert.fail('stale pool callback'),
  });
  assert.equal(r.status, 'unknown');
  assert.equal(r.buyIn.requestId, OP);
  assert.deepEqual(f.actions, ['join', 'buy']);
  assert.equal(r.cleanup, 'local_session_and_browser_closed');
});

test('a seated join resumes only its actual pool and never purchases another seat', async () => {
  for (const joinedExistingPool of [true, false]) {
    const f = fixture({ joinAction: 'seated', joinedExistingPool });
    const report = await witnessAdmission(f.args);
    assert.equal(report.status, joinedExistingPool ? 'observed' : 'unknown');
    if (joinedExistingPool) assert.equal(report.admissionOutcome, 'read_only_resume');
    assert.deepEqual(f.actions, ['join']);
    assert.equal(report.buyIn.outcome, 'not_requested');
    assert.deepEqual(f.rpc, []);
    assert.equal(report.cleanup, 'local_session_and_browser_closed');
  }
});

test('Classic admission refuses before authentication even when the private game otherwise matches', async () => {
  const f = fixture();
  delete f.args.validateScope;
  f.args.admin.from = (table) => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({
        data:
          table === 'clubs'
            ? {
                id: CLUB,
                owner_id: '2d1cd6c3-5700-4af9-a271-d4863fdab20d',
                name: 'Lightning Internal Pilot',
                is_public: false,
                requires_approval: true,
              }
            : {
                id: CLUSTER,
                club_id: CLUB,
                name: 'Lightning Pilot NLH Action 6',
                template_name: 'classic',
                handedness: 6,
                sb: 0.01,
                bb: 0.02,
                variant: 'nlh',
                enabled: true,
                must_move: true,
                cluster_mode: 'lightning',
                lightning_enabled: true,
                ruleset_snapshot: {
                  template: 'action',
                  variant: 'nlh',
                  regular_ante: 'sb',
                  vpip_floor: 30,
                  vpip_window: 10,
                  bombs: { enabled: true, trigger: 'timed_20m', ante_bb: 2, boards: 2 },
                  options: { is_private: true },
                },
              },
      }),
    };
    return q;
  };
  const result = await witnessAdmission(f.args);
  assert.equal(result.status, 'unknown');
  assert.equal(result.phase, 'scope');
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.cleanup, []);
});

test('the device welcome over a fresh entry is acknowledged once through its own controls, then one join and one buy-in', async () => {
  // Runs 39160085181 and 39295960542: a fresh browser met the shell's first-run
  // welcome over Join Lightning; the tap never landed and the run spent its
  // whole budget reporting only "join unknown".
  const f = fixture({
    doors: [
      { door: 'join_lightning', layer: 'device_welcome' },
      { door: 'join_lightning', layer: 'clear' },
    ],
  });
  const r = await witnessAdmission(f.args);
  assert.equal(r.status, 'observed');
  assert.deepEqual(f.actions, [
    'welcome:I Understand And Agree To These Terms',
    'welcome:Enter Poker Arena',
    'join',
    'buy',
  ]);
  assert.equal(r.join.entry.answered.device_welcome, 'acknowledged_on_this_device');
  assert.equal(r.join.entry.layer, 'clear');
  assert.equal(r.join.tap, 'sent');
  assert.equal(r.join.reply, 'ok');
  assert.equal(r.join.tableId, TABLE);
});

test('a daily bonus sheet over the door is put off with Not Now and never claimed', async () => {
  const f = fixture({
    doors: [
      { door: 'join_lightning', layer: 'daily_bonus' },
      { door: 'join_lightning', layer: 'clear' },
    ],
  });
  const r = await witnessAdmission(f.args);
  assert.equal(r.status, 'observed');
  assert.deepEqual(f.actions, ['daily_bonus:Not Now', 'join', 'buy']);
  assert.ok(!f.actions.some((a) => /Claim/.test(a)));
});

test('a door that is not offered, or is covered by anything else, is reported and never tapped', async () => {
  for (const [door, layer] of [
    ['view_game', 'none'],
    ['join_game', 'clear'],
    ['joins_closed', 'none'],
    ['entry_unavailable', 'clear'],
    ['join_lightning', 'profile_gate'],
    ['join_lightning', 'age_gate'],
    ['join_lightning', 'other'],
  ]) {
    const f = fixture({ doors: [{ door, layer }] });
    const r = await witnessAdmission(f.args);
    assert.equal(r.status, 'unknown');
    assert.equal(r.phase, 'entry_door');
    assert.equal(r.join.outcome, 'not_offered');
    assert.equal(r.join.entry.door, door);
    assert.equal(r.join.entry.layer, layer);
    assert.deepEqual(f.actions, []);
    assert.equal(r.buyIn.outcome, 'not_requested');
    assert.equal(r.cleanup, 'local_session_and_browser_closed');
  }
  const g = fixture({ doors: [{ door: 'join_lightning', layer: 'device_welcome' }] });
  const welcomeTwice = await witnessAdmission(g.args);
  assert.equal(welcomeTwice.join.outcome, 'not_offered');
  assert.equal(g.actions.filter((a) => a === 'welcome:Enter Poker Arena').length, 1);
});

test('a refused join keeps only its native leading code', async () => {
  assert.equal(joinRefusalCode({ message: 'GAME_BARRED:240' }), 'GAME_BARRED');
  assert.equal(joinRefusalCode({ message: 'INSUFFICIENT_CHIPS:4.00' }), 'INSUFFICIENT_CHIPS');
  assert.equal(joinRefusalCode({ message: `free text ${SECRET}` }), null);
  assert.equal(joinRefusalCode(null), null);
  const f = fixture({ joinRefusal: `PRIVATE_MEMBERSHIP_REQUIRED: ${SECRET}` });
  const r = await witnessAdmission(f.args);
  assert.equal(r.status, 'unknown');
  assert.equal(r.join.reply, 'refused');
  assert.equal(r.join.refusal, 'PRIVATE_MEMBERSHIP_REQUIRED');
  assert.deepEqual(f.actions, ['join']);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
});

test('the in-page door reader returns fixed classes and names the layer over the button', () => {
  const button = { textContent: ' Join Lightning ', contains: (n) => n === button };
  button.scrollIntoView = () => {};
  button.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10 });
  const overlay = {
    closest: () => null,
    querySelector: (sel) => (sel === ENTRY_LAYERS[0][0] ? {} : null),
  };
  let top = button;
  const entry = {
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [{ textContent: 'Return To Lobby' }, button],
  };
  globalThis.location = { pathname: `/hub/club-arena/lightning/${CLUSTER}` };
  globalThis.document = {
    querySelector: (sel) =>
      sel === '[data-testid="lightning-entry"]' ? entry : { getAttribute: () => 'complete' },
    elementFromPoint: () => top,
  };
  try {
    const arg = { clusterId: CLUSTER, doors: ENTRY_DOORS, layers: ENTRY_LAYERS };
    assert.deepEqual(entryDoorInPage(arg), {
      route: 'entry',
      profileGate: 'complete',
      settled: true,
      door: 'join_lightning',
      layer: 'clear',
    });
    top = overlay;
    assert.equal(entryDoorInPage(arg).layer, 'device_welcome');
    globalThis.location = { pathname: `/hub/club-arena/table/${TABLE}` };
    assert.equal(entryDoorInPage(arg).route, 'table');
    assert.equal(entryDoorInPage(arg).settled, false);
  } finally {
    delete globalThis.location;
    delete globalThis.document;
  }
});

test('a layer answer that fails keeps the door, the layer, the step and only a fixed failure class', async () => {
  // Run 39306906465 stopped inside the entry door in ~10 s with no door evidence.
  const error = new Error(
    `locator.click: Timeout 10000ms exceeded.\n<div class="x">${SECRET}</div> intercepts pointer events`
  );
  error.name = 'TimeoutError';
  const f = fixture({
    doors: [
      { door: 'join_lightning', layer: 'device_welcome' },
      { door: 'join_lightning', layer: 'clear' },
    ],
    layerFailure: { control: 'I Understand And Agree To These Terms', error },
  });
  const r = await witnessAdmission(f.args);
  assert.equal(r.status, 'unknown');
  assert.equal(r.phase, 'entry_door');
  assert.equal(r.join.entry.door, 'join_lightning');
  assert.equal(r.join.entry.layer, 'device_welcome');
  assert.equal(r.join.entry.profileGate, 'complete');
  assert.equal(r.join.entry.answered.device_welcome, 'pending');
  assert.equal(r.join.entry.answerStep, 'welcome_agree');
  assert.equal(r.join.entry.failure, 'timeout_intercepted');
  assert.deepEqual(f.actions, []);
  assert.equal(r.cleanup, 'local_session_and_browser_closed');
  assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
});

test('Playwright failures reduce to fixed classes', () => {
  const t = (message, name = 'TimeoutError') => Object.assign(new Error(message), { name });
  assert.equal(
    uiFailureClass(t('Timeout 5ms exceeded. x intercepts pointer events')),
    'timeout_intercepted'
  );
  assert.equal(
    uiFailureClass(t('Timeout 5ms exceeded. element is outside of the viewport')),
    'timeout_outside_viewport'
  );
  assert.equal(
    uiFailureClass(t('Timeout 5ms exceeded. element is not visible')),
    'timeout_not_visible'
  );
  assert.equal(uiFailureClass(t('Timeout 5ms exceeded. waiting for locator')), 'timeout');
  assert.equal(
    uiFailureClass(t('strict mode violation: resolved to 2 elements', 'Error')),
    'strict_mode_violation'
  );
  assert.equal(
    uiFailureClass(
      t('Execution context was destroyed, most likely because of a navigation', 'Error')
    ),
    'navigated'
  );
  assert.equal(uiFailureClass(t('Device Welcome Unverified', 'Error')), 'welcome_unverified');
  assert.equal(uiFailureClass(t(SECRET, 'Error')), 'other');
  assert.equal(uiFailureClass(null), 'other');
});

test('the normal buy-in intent with a null club is the same exact intent when its receipt and owned anchor agree', async () => {
  // Run 39312801627: welcome, join and one buy-in landed (wallet 146.78 to 142.78,
  // pool c5a84f27), but the witness refused the actual intent for its null club.
  const nullClub = { ...payload, p_club_id: null };
  const f = fixture({
    buyPayload: nullClub,
    receiptValue: { status: 'confirmed', request: { ...receipt.request, club_id: null } },
  });
  const r = await witnessAdmission(f.args);
  assert.equal(r.status, 'observed');
  assert.equal(r.admissionOutcome, 'admitted');
  assert.equal(r.buyIn.receipt, 'confirmed_exact_intent');
  assert.deepEqual(f.actions, ['join', 'buy']);
  // A different club, or a receipt that disagrees with the sent intent, stays unknown.
  for (const options of [
    { buyPayload: { ...payload, p_club_id: POOL } },
    { buyPayload: nullClub },
  ]) {
    const g = fixture(options);
    const u = await witnessAdmission(g.args);
    assert.equal(u.status, 'unknown');
    assert.deepEqual(g.actions, ['join', 'buy']);
  }
});

test('daily bonus dismissal contract matches its real named secondary plate', () => {
  const source = readFileSync(
    new URL('../../src/components/daily-bonus/DailyBonusSheet.tsx', import.meta.url),
    'utf8'
  );
  assert.match(
    source,
    /secondary:\s*\{[\s\S]*?label: 'Not Now'[\s\S]*?onClick: onClose,[\s\S]*?'aria-label': 'Close'/
  );
});

test('admission accepts exactly the consented witness players and refuses anyone else first', async () => {
  const { WITNESS_PLAYERS } = await import('./lightning-pilot-player.mjs');
  assert.ok(WITNESS_PLAYERS.includes(ADMISSION_PLAYER));
  assert.ok(WITNESS_PLAYERS.length >= 3);
  let auth = 0;
  const f = fixture();
  f.args.admin.auth.admin.getUserById = async () => {
    auth++;
    throw new Error();
  };
  const r = await witnessAdmission({
    ...f.args,
    pin: { ...pin, playerId: '23040e91-e0d0-430d-b18e-f9f67c385d90' },
  });
  assert.equal(r.status, 'unknown');
  assert.equal(r.playerId, null);
  assert.equal(auth, 0);
});

test('a consented witness on another house email domain signs in; an account with no email never does', async () => {
  for (const [email, ok] of [
    ['milehigh@hydra.smarter.poker', true],
    ['player009@smarter.poker', true],
    ['', false],
    [null, false],
  ]) {
    const f = fixture();
    f.args.admin.auth.admin.getUserById = async () => ({
      data: { user: { id: ADMISSION_PLAYER, email } },
    });
    const r = await witnessAdmission({
      ...f.args,
      withAdmittedSession: async () => ({ status: 'observed' }),
    });
    if (ok) assert.notEqual(r.phase, 'authentication');
    else {
      assert.equal(r.status, 'unknown');
      assert.deepEqual(f.actions, []);
    }
  }
});
