import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  witnessAdmission,
  ADMISSION_PLAYER,
  admissionReceiptMatches,
  readAdmissionPool,
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
} = {}) {
  const actions = [],
    cleanup = [],
    rpc = [],
    events = new Map();
  let poolReads = 0;
  const request = (name) => ({
    method: () => 'POST',
    url: () => `https://example.invalid/rest/v1/rpc/${name}`,
    postDataJSON: () => payload,
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
    locator: (selector) =>
      selector.includes(':visible')
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
        json: async () => ({ ok: true, action: joinAction, table_id: TABLE }),
      };
      if (predicate(join)) return join;
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
    validateScope: async () => 200,
    readOwnPool: async () => {
      poolReads++;
      return preexisting || (poolAfter && poolReads >= 3)
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
                  name: 'Lightning Pilot NLH 6',
                  handedness: 6,
                  sb: 0.01,
                  bb: 0.02,
                  variant: 'nlh',
                  enabled: true,
                  must_move: true,
                  cluster_mode: 'lightning',
                  lightning_enabled: true,
                  ruleset_snapshot: { options: { is_private: true } },
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
  let reads = 0;
  f.args.readOwnPool = async () => {
    reads += 1;
    return reads === 3 ? { poolSessionId: POOL, cashPlayerSessionId: CASH } : null;
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
