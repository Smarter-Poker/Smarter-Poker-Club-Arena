import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openDesignatedOutsiderSession,
  PILOT_OUTSIDER,
  socketAccess,
  browserAccess,
  acceptDesignatedTerms,
} from './lightning-pilot-access.mjs';
import { EventEmitter } from 'node:events';
const TOKEN = 'TEST_TOKEN_NOT_A_CREDENTIAL';
function fixture(mode) {
  const calls = [];
  const id = mode === 'wrong-user' ? 'another' : PILOT_OUTSIDER;
  const client = {
    auth: {
      verifyOtp: async (a) => {
        calls.push(['verifyOtp', a]);
        return mode === 'verify-error'
          ? { error: { message: TOKEN } }
          : {
              data: {
                user: { id: PILOT_OUTSIDER },
                session: { access_token: TOKEN, user: { id: PILOT_OUTSIDER } },
              },
            };
      },
      getUser: async () => ({
        data: { user: { id: mode === 'wrong-session' ? 'another' : PILOT_OUTSIDER } },
      }),
      signOut: async (a) => {
        calls.push(['signOut', a]);
        return {};
      },
    },
  };
  const admin = {
    auth: {
      admin: {
        getUserById: async () => ({
          data: { user: { id, email: 'designated@bot.smarter.poker' } },
        }),
        generateLink: async (a) => {
          calls.push(['generateLink', a]);
          return {
            data: {
              user: { id: mode === 'wrong-link' ? 'another' : PILOT_OUTSIDER },
              properties: { hashed_token: TOKEN },
            },
          };
        },
      },
    },
  };
  return { calls, client, admin, factory: () => client };
}
test('a verified synthetic session belongs to the designated existing identity', async () => {
  const f = fixture();
  const r = await openDesignatedOutsiderSession(f.admin, f.factory, 'https://example.invalid');
  assert.equal(r.session.user.id, PILOT_OUTSIDER);
  assert.equal(f.calls[0][0], 'generateLink');
  assert.equal(f.calls[0][1].type, 'magiclink');
  assert.deepEqual(f.calls[1], ['verifyOtp', { token_hash: TOKEN, type: 'email' }]);
});
for (const mode of ['wrong-user', 'wrong-link'])
  test(`${mode} refuses before a synthetic login`, async () => {
    const f = fixture(mode);
    await assert.rejects(
      openDesignatedOutsiderSession(f.admin, f.factory, 'https://example.invalid')
    );
    assert.equal(f.calls.filter((x) => x[0] === 'verifyOtp').length, 0);
  });
for (const mode of ['verify-error', 'wrong-session'])
  test(`${mode} cleans up only its own session`, async () => {
    const f = fixture(mode);
    await assert.rejects(
      openDesignatedOutsiderSession(f.admin, f.factory, 'https://example.invalid')
    );
    assert.deepEqual(
      f.calls.filter((x) => x[0] === 'signOut'),
      [['signOut', { scope: 'local' }]]
    );
  });
test('a socket refusal records actual HTTP status without copying token or headers', async () => {
  class Socket extends EventEmitter {
    constructor(url, protocol) {
      super();
      assert.match(url, /^wss:\/\/engine.smarter.poker\/ws\/table\//);
      assert.deepEqual(protocol, ['bearer', TOKEN]);
      queueMicrotask(() => this.emit('unexpected-response', {}, { statusCode: 403, resume() {} }));
    }
    close() {}
  }
  const r = await socketAccess(Socket, '00000000-0000-4000-8000-000000000001', TOKEN);
  assert.deepEqual(r, { outcome: 'refused', status: 403 });
  assert.doesNotMatch(JSON.stringify(r), new RegExp(TOKEN));
});
test('socket network errors remain unknown and cannot count as an access refusal', async () => {
  class Socket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('error', new Error(TOKEN)));
    }
    close() {}
  }
  assert.deepEqual(await socketAccess(Socket, '00000000-0000-4000-8000-000000000001', TOKEN), {
    outcome: 'unknown',
    status: null,
  });
});
test('browser observer refuses visible private discovery and closes its isolated browser', async () => {
  let closed = 0;
  const page = {
    goto: async () => {},
    waitForFunction: async () => {},
    url: () => 'https://smarter.poker/hub/club-arena/lightning/pilot',
    locator: () => ({ waitFor: async () => {}, innerText: async () => 'Game Unavailable' }),
    evaluate: async () => ({ userId: PILOT_OUTSIDER, status: 200, ids: ['pilot'] }),
  };
  const chromium = {
    launch: async () => ({
      newContext: async () => ({
        addInitScript: async () => {},
        newPage: async () => page,
        close: async () => {},
      }),
      close: async () => {
        closed++;
      },
    }),
  };
  await assert.rejects(
    browserAccess(
      chromium,
      { access_token: TOKEN, user: { id: PILOT_OUTSIDER } },
      'outsider',
      [{ id: 'pilot' }],
      'https://example.invalid'
    ),
    (error) => error.browserDiagnostic?.cause === 'private_discovery_visible'
  );
  assert.equal(closed, 1);
});

test('a pending-request transport failure retains unknown outcome and cleans only its session', async () => {
  const { runPilotAccess } = await import('./lightning-pilot-access.mjs');
  const f = fixture();
  const club = '00000000-0000-4000-8000-000000000010';
  const game = '00000000-0000-4000-8000-000000000011';
  let cancel = 0;
  f.client.rpc = async (name) => {
    if (name === 'fn_join_club_atomic') return { error: { message: TOKEN } };
    if (name === 'fn_cash_game_join')
      return { error: { code: '23514', message: 'INSUFFICIENT_CHIPS:1' } };
    if (name === 'fn_cancel_club_join_request') {
      cancel++;
      return { data: true };
    }
    throw new Error('Unexpected RPC');
  };
  f.admin.from = (table) => {
    const q = {
      select: (columns) => {
        if (table === 'club_members') {
          assert.equal(columns, 'club_id,user_id,joined_at,status,chip_balance');
        }
        return q;
      },
      eq: () => q,
      in: () => q,
      maybeSingle: async () => ({
        data:
          table === 'clubs'
            ? {
                id: club,
                owner_id: '2d1cd6c3-5700-4af9-a271-d4863fdab20d',
                is_public: false,
                requires_approval: true,
              }
            : null,
      }),
      then: (resolve, reject) =>
        Promise.resolve({ data: [{ id: game, cluster_id: game }] }).then(resolve, reject),
    };
    return q;
  };
  const player = {
    auth: {
      getSession: async () => ({
        data: {
          session: {
            access_token: 'OWNER_TEST',
            user: { id: '2d1cd6c3-5700-4af9-a271-d4863fdab20d' },
          },
        },
      }),
    },
  };
  let result;
  try {
    await runPilotAccess({
      admin: f.admin,
      player,
      createClient: f.factory,
      url: 'https://example.invalid',
      games: [{ id: game, club_id: club, ruleset_snapshot: { options: { is_private: true } } }],
      operationId: 'operation',
      requestId: 'request',
      observeBrowser: async () => [],
      observeSocket: async (_ws, _id, token) =>
        token === 'OWNER_TEST'
          ? { outcome: 'opened', status: 101 }
          : { outcome: 'refused', status: 403 },
    });
  } catch (error) {
    result = error.pilotAccessReport;
  }
  assert.equal(result.verdict, 'failed_or_unknown');
  assert.equal(result.cleanup.pendingRequest, 'unknown_request_outcome');
  assert.equal(result.cleanup.outsiderSession, 'local_signout_confirmed');
  assert.equal(cancel, 0);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
});

test('the browser websocket receives the verified anchor ID, and an actual closed socket is required', async () => {
  const page = {
    goto: async () => {},
    waitForFunction: async () => {},
    url: () => 'https://smarter.poker/hub/club-arena/lightning/pilot',
    locator: () => ({ waitFor: async () => {}, innerText: async () => 'Game Unavailable' }),
    evaluate: async (_fn, args) => {
      assert.equal(args.tableId, 'verified-anchor');
      return {
        userId: PILOT_OUTSIDER,
        status: 200,
        ids: [],
        socket: { opened: false, messages: 0, closedCode: 1006, observedError: true },
      };
    },
  };
  const chromium = {
    launch: async () => ({
      newContext: async () => ({
        addInitScript: async () => {},
        newPage: async () => page,
        close: async () => {},
      }),
      close: async () => {},
    }),
  };
  const r = await browserAccess(
    chromium,
    { access_token: TOKEN, user: { id: PILOT_OUTSIDER } },
    'outsider',
    [{ id: 'pilot', name: 'Pilot', accessTableIds: ['verified-anchor'] }],
    'https://example.invalid'
  );
  assert.equal(r[0].entry, 'refused');
  assert.equal(r[0].browserSocket.opened, false);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(TOKEN));
});

test('both outsider states stay unapproved and unfunded, with pending cancellation read back', async () => {
  const { runPilotAccess } = await import('./lightning-pilot-access.mjs');
  const f = fixture();
  const club = '00000000-0000-4000-8000-000000000010',
    game = '00000000-0000-4000-8000-000000000011';
  let row = null;
  const operations = [];
  f.client.rpc = async (name, args) => {
    operations.push({ name, args });
    if (name === 'fn_join_club_atomic') {
      row = { status: 'pending', chip_balance: 0 };
      return { data: { success: true } };
    }
    if (name === 'fn_cancel_club_join_request') {
      row = null;
      return { data: true };
    }
    if (name === 'fn_cash_game_join')
      return { error: { code: '23514', message: 'INSUFFICIENT_CHIPS:1' } };
    throw new Error('Unexpected RPC');
  };
  f.admin.from = (table) => {
    const q = {
      select: (columns) => {
        if (table === 'club_members') {
          assert.equal(columns, 'club_id,user_id,joined_at,status,chip_balance');
        }
        return q;
      },
      eq: () => q,
      in: () => q,
      maybeSingle: async () => ({
        data:
          table === 'clubs'
            ? {
                id: club,
                owner_id: '2d1cd6c3-5700-4af9-a271-d4863fdab20d',
                is_public: false,
                requires_approval: true,
              }
            : row,
      }),
      then: (resolve, reject) =>
        Promise.resolve({ data: [{ id: game, cluster_id: game }] }).then(resolve, reject),
    };
    return q;
  };
  const r = await runPilotAccess({
    admin: f.admin,
    player: {
      auth: {
        getSession: async () => ({
          data: {
            session: {
              access_token: 'OWNER_TEST',
              user: { id: '2d1cd6c3-5700-4af9-a271-d4863fdab20d' },
            },
          },
        }),
      },
    },
    createClient: f.factory,
    url: 'https://example.invalid',
    games: [{ id: game, club_id: club, ruleset_snapshot: { options: { is_private: true } } }],
    operationId: 'operation',
    requestId: 'request',
    observeBrowser: async () => [],
    observeSocket: async (_ws, _id, token) =>
      token === 'OWNER_TEST'
        ? { outcome: 'opened', status: 101 }
        : { outcome: 'refused', status: 403 },
  });
  assert.equal(r.verdict, 'passed');
  assert.deepEqual(
    r.states.map((s) => s.state),
    ['owner', 'nonmember', 'pending']
  );
  assert.equal(r.cleanup.pendingRequest, 'removed_and_absence_verified');
  assert.equal(row, null);
  assert.deepEqual(
    operations.map((x) => x.name),
    ['fn_cash_game_join', 'fn_join_club_atomic', 'fn_cash_game_join', 'fn_cancel_club_join_request']
  );
  assert.doesNotMatch(JSON.stringify(r), new RegExp(TOKEN));
});

test('browser locator failure retains bounded diagnostics without raw browser secrets', async () => {
  let closed = false;
  const chromium = {
    launch: async () => ({
      newContext: async () => ({
        addInitScript: async () => {},
        newPage: async () => ({
          goto: async () => {},
          url: () => `https://smarter.poker/auth?token=${TOKEN}`,
          locator: () => ({
            waitFor: async () => {
              throw new Error(TOKEN);
            },
          }),
          evaluate: async () => ({ entryVisible: false, refusalVisible: false, token: TOKEN }),
        }),
      }),
      close: async () => {
        closed = true;
      },
    }),
  };
  await assert.rejects(
    browserAccess(
      chromium,
      { access_token: TOKEN, user: { id: PILOT_OUTSIDER } },
      'outsider',
      [{ id: 'pilot' }],
      'https://example.invalid'
    ),
    (error) => {
      assert.equal(error.browserDiagnostic.subphase, 'entry_locator');
      assert.equal(error.browserDiagnostic.cause, 'entry_locator_failed');
      assert.equal(error.browserDiagnostic.clusterId, 'pilot');
      assert.equal(error.browserDiagnostic.path, 'other');
      assert.equal(error.browserDiagnostic.entryVisible, false);
      assert.doesNotMatch(JSON.stringify(error), new RegExp(TOKEN));
      assert.doesNotMatch(error.message, new RegExp(TOKEN));
      return true;
    }
  );
  assert.equal(closed, true);
});

test('consent is opt-in and pinned to the designated outsider', async () => {
  assert.deepEqual(await acceptDesignatedTerms({}, {}, 'outsider', '', false), {
    authorized: false,
    acceptedNow: false,
  });
  for (const [actor, id] of [
    ['owner', PILOT_OUTSIDER],
    ['outsider', 'another-user'],
  ]) {
    await assert.rejects(
      acceptDesignatedTerms({}, { user: { id } }, actor, '', true),
      /Designated Outsider/
    );
  }
});

test('authorized consent uses the visible normal UI and confirmed owning gate exactly once', async () => {
  const calls = [];
  let status = 'not_accepted';
  const dialog = {
    waitFor: async () => calls.push('dialog'),
    locator: (selector) => ({
      evaluate: async () => {
        assert.equal(selector, '.tosc__terms');
        calls.push('scroll');
      },
    }),
    getByRole: (role, options) => ({
      check: async () => {
        assert.equal(role, 'checkbox');
        assert.match(options.name, /Privacy Policy/);
        calls.push('check');
      },
      click: async () => {
        assert.equal(role, 'button');
        assert.equal(options.name, 'Accept & Continue');
        calls.push('accept');
        status = 'accepted';
      },
    }),
  };
  const page = {
    waitForFunction: async () => {},
    locator: () => ({ getAttribute: async () => status }),
    evaluate: async () => true,
    getByRole: (role, options) => {
      assert.equal(role, 'dialog');
      assert.equal(options.name, 'Terms Of Service');
      return dialog;
    },
  };
  const session = { user: { id: PILOT_OUTSIDER }, access_token: TOKEN };
  assert.deepEqual(await acceptDesignatedTerms(page, session, 'outsider', '', true), {
    authorized: true,
    acceptedNow: true,
    status: 'accepted',
  });
  assert.deepEqual(calls, ['dialog', 'scroll', 'check', 'accept']);
  assert.equal(
    (await acceptDesignatedTerms(page, session, 'outsider', '', true)).acceptedNow,
    false
  );
  assert.equal(calls.length, 4);
  status = 'not_accepted';
  page.evaluate = async () => false;
  await assert.rejects(
    acceptDesignatedTerms(page, session, 'outsider', '', true),
    /Identity Unverified/
  );
  assert.equal(calls.length, 4);
});

test('failed join replies retain sanitized diagnostics and earlier browser/socket observations', async () => {
  const { runPilotAccess } = await import('./lightning-pilot-access.mjs');
  const club = '00000000-0000-4000-8000-000000000010';
  const game = '00000000-0000-4000-8000-000000000011';
  const ownerId = '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  for (const [reply, expected] of [
    [
      {
        error: { code: '42501', message: 'PRIVATE_MEMBERSHIP_REQUIRED_UNKNOWN' },
        data: { ok: false },
      },
      {
        ok: false,
        errorSQLSTATE: '42501',
        reason: 'PRIVATE_MEMBERSHIP_REQUIRED',
        admittedAction: 'UNKNOWN',
        cleanup: 'not_requested',
      },
    ],
    ...['23514', undefined].map((code) => [
      { error: { code, message: 'PRIVATE_MEMBERSHIP_REQUIRED' }, data: { ok: false } },
      {
        ok: false,
        errorSQLSTATE: code ?? 'UNKNOWN',
        reason: 'PRIVATE_MEMBERSHIP_REQUIRED',
        admittedAction: 'UNKNOWN',
        cleanup: 'not_requested',
      },
    ]),
    [
      { data: { ok: true, action: 'seat', secret: TOKEN } },
      {
        ok: true,
        errorSQLSTATE: 'UNKNOWN',
        reason: 'UNRECOGNIZED',
        admittedAction: 'seat',
        cleanup: 'reply_ok',
      },
    ],
    [
      { data: { ok: true, action: 'waitlisted', secret: TOKEN } },
      {
        ok: true,
        errorSQLSTATE: 'UNKNOWN',
        reason: 'UNRECOGNIZED',
        admittedAction: 'waitlisted',
        cleanup: 'reply_ok',
      },
    ],
    [
      {
        error: { code: '23514', message: 'NEW_REFUSAL:' + TOKEN },
        data: { ok: false, action: TOKEN },
      },
      {
        ok: false,
        errorSQLSTATE: '23514',
        reason: 'UNRECOGNIZED',
        admittedAction: 'UNKNOWN',
        cleanup: 'not_requested',
      },
    ],
    [
      { data: { ok: false, reason: 'NOT_MEMBER', action: TOKEN } },
      {
        ok: false,
        errorSQLSTATE: 'UNKNOWN',
        reason: 'NOT_MEMBER',
        admittedAction: 'UNKNOWN',
        cleanup: 'not_requested',
      },
    ],
    [
      { error: { code: TOKEN, message: TOKEN } },
      {
        ok: null,
        errorSQLSTATE: 'UNKNOWN',
        reason: 'UNRECOGNIZED',
        admittedAction: 'UNKNOWN',
        cleanup: 'not_requested',
      },
    ],
  ]) {
    const f = fixture();
    f.client.rpc = async (name) => {
      if (name === 'fn_cash_game_join') return reply;
      if (name === 'fn_cash_game_leave_waitlist') return { data: { ok: true, cancelled: 0 } };
      throw new Error('Unexpected RPC');
    };
    f.admin.from = (table) => {
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        maybeSingle: async () => ({
          data:
            table === 'clubs'
              ? { id: club, owner_id: ownerId, is_public: false, requires_approval: true }
              : null,
        }),
        then: (resolve, reject) =>
          Promise.resolve({ data: [{ id: game, cluster_id: game }] }).then(resolve, reject),
      };
      return q;
    };
    let report;
    try {
      await runPilotAccess({
        admin: f.admin,
        player: {
          auth: {
            getSession: async () => ({
              data: { session: { access_token: 'OWNER_TEST', user: { id: ownerId } } },
            }),
          },
        },
        createClient: f.factory,
        url: 'https://example.invalid',
        games: [{ id: game, club_id: club, ruleset_snapshot: { options: { is_private: true } } }],
        operationId: 'operation',
        requestId: 'request',
        observeBrowser: async () => [{ clusterId: game, entry: 'observed' }],
        observeSocket: async (_ws, _id, token) =>
          token === 'OWNER_TEST'
            ? { outcome: 'opened', status: 101 }
            : { outcome: 'refused', status: 403 },
      });
      assert.fail('Invalid Join Proof Must Remain Failed');
    } catch (error) {
      report = error.pilotAccessReport;
    }
    assert.equal(report.verdict, 'failed_or_unknown');
    assert.equal(report.phase, 'nonmember_joins');
    const observation = report.states.find((state) => state.state === 'nonmember');
    assert.equal(observation.browser[0].entry, 'observed');
    assert.equal(observation.sockets[0].status, 403);
    assert.deepEqual(observation.joins[0], { clusterId: game, ...expected, refused: false });
    assert.equal(report.cleanup.outsiderSession, 'local_signout_confirmed');
    assert.doesNotMatch(JSON.stringify(report), new RegExp(TOKEN));
  }
});

test('private membership guard requires its exact SQLSTATE on nonmember and pending refusal', async () => {
  const { runPilotAccess } = await import('./lightning-pilot-access.mjs');
  const f = fixture();
  const club = '00000000-0000-4000-8000-000000000010',
    game = '00000000-0000-4000-8000-000000000011';
  let row = null;
  const operations = [];
  f.client.rpc = async (name, args) => {
    operations.push({ name, args });
    if (name === 'fn_join_club_atomic') {
      row = { status: 'pending', chip_balance: 0 };
      return { data: { success: true } };
    }
    if (name === 'fn_cancel_club_join_request') {
      row = null;
      return { data: true };
    }
    if (name === 'fn_cash_game_join')
      return { error: { code: '42501', message: 'PRIVATE_MEMBERSHIP_REQUIRED' } };
    throw new Error('Unexpected RPC');
  };
  f.admin.from = (table) => {
    const q = {
      select: (columns) => {
        if (table === 'club_members') {
          assert.equal(columns, 'club_id,user_id,joined_at,status,chip_balance');
        }
        return q;
      },
      eq: () => q,
      in: () => q,
      maybeSingle: async () => ({
        data:
          table === 'clubs'
            ? {
                id: club,
                owner_id: '2d1cd6c3-5700-4af9-a271-d4863fdab20d',
                is_public: false,
                requires_approval: true,
              }
            : row,
      }),
      then: (resolve, reject) =>
        Promise.resolve({ data: [{ id: game, cluster_id: game }] }).then(resolve, reject),
    };
    return q;
  };
  const r = await runPilotAccess({
    admin: f.admin,
    player: {
      auth: {
        getSession: async () => ({
          data: {
            session: {
              access_token: 'OWNER_TEST',
              user: { id: '2d1cd6c3-5700-4af9-a271-d4863fdab20d' },
            },
          },
        }),
      },
    },
    createClient: f.factory,
    url: 'https://example.invalid',
    games: [{ id: game, club_id: club, ruleset_snapshot: { options: { is_private: true } } }],
    operationId: 'operation',
    requestId: 'request',
    observeBrowser: async () => [],
    observeSocket: async (_ws, _id, token) =>
      token === 'OWNER_TEST'
        ? { outcome: 'opened', status: 101 }
        : { outcome: 'refused', status: 403 },
  });
  assert.equal(r.verdict, 'passed');
  for (const state of r.states.filter((row) => row.state !== 'owner')) {
    assert.equal(state.joins[0].reason, 'PRIVATE_MEMBERSHIP_REQUIRED');
    assert.equal(state.joins[0].errorSQLSTATE, '42501');
    assert.equal(state.joins[0].refused, true);
  }
  assert.deepEqual(
    r.states.map((s) => s.state),
    ['owner', 'nonmember', 'pending']
  );
  assert.equal(r.cleanup.pendingRequest, 'removed_and_absence_verified');
  assert.equal(row, null);
  assert.deepEqual(
    operations.map((x) => x.name),
    ['fn_cash_game_join', 'fn_join_club_atomic', 'fn_cash_game_join', 'fn_cancel_club_join_request']
  );
  assert.doesNotMatch(JSON.stringify(r), new RegExp(TOKEN));
});

const thenOnly = (value) => ({
  then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
});
function recoveryFixture(initial = null, receiptPatch = {}) {
  const f = fixture();
  const club = '00000000-0000-4000-8000-000000000010',
    game = '00000000-0000-4000-8000-000000000011';
  const requestId = '00000000-0000-4000-8000-000000000012';
  let row = initial;
  const operations = [];
  const receipt = {
    user_id: PILOT_OUTSIDER,
    request_id: requestId,
    club_id: club,
    result: {
      success: true,
      status: 'pending',
      club: { id: club },
      membership: initial ? { ...initial } : null,
    },
    ...receiptPatch,
  };
  f.admin.from = (table) => {
    const q = {
      select: (columns) => {
        if (table === 'club_members') {
          assert.equal(columns, 'club_id,user_id,joined_at,status,chip_balance');
        }
        return q;
      },
      eq: () => q,
      in: () => q,
      maybeSingle: async () => ({
        data:
          table === 'clubs'
            ? {
                id: club,
                owner_id: '2d1cd6c3-5700-4af9-a271-d4863fdab20d',
                is_public: false,
                requires_approval: true,
              }
            : table === 'club_join_idempotency'
              ? receipt
              : row,
      }),
      then: (resolve, reject) =>
        Promise.resolve({ data: [{ id: game, cluster_id: game }] }).then(resolve, reject),
    };
    return q;
  };
  f.client.rpc = (name) => {
    operations.push(name);
    if (name === 'fn_join_club_atomic') {
      row = { status: 'pending', chip_balance: 0 };
      return thenOnly({ data: { success: true } });
    }
    if (name === 'fn_cancel_club_join_request') {
      row = null;
      return thenOnly({ data: true });
    }
    if (name === 'fn_cash_game_join')
      return thenOnly({ error: { code: '42501', message: 'PRIVATE_MEMBERSHIP_REQUIRED' } });
    throw new Error('Unexpected RPC');
  };
  return {
    ...f,
    club,
    operations,
    getRow: () => row,
    args: {
      admin: f.admin,
      player: {
        auth: {
          getSession: async () => ({
            data: {
              session: {
                access_token: 'OWNER_TEST',
                user: { id: '2d1cd6c3-5700-4af9-a271-d4863fdab20d' },
              },
            },
          }),
        },
      },
      createClient: f.factory,
      url: 'https://example.invalid',
      games: [{ id: game, club_id: club, ruleset_snapshot: { options: { is_private: true } } }],
      requestId,
      operationId: 'operation',
      observeBrowser: async () => [],
      observeSocket: async (_ws, _id, token) =>
        token === 'OWNER_TEST'
          ? { outcome: 'opened', status: 101 }
          : { outcome: 'refused', status: 403 },
    },
  };
}
test('then-only RPC cleanup preserves the primary report and still signs out locally', async () => {
  const { runPilotAccess } = await import('./lightning-pilot-access.mjs');
  const f = recoveryFixture();
  f.args.observeBrowser = async () => {
    if (f.getRow()) throw new Error(TOKEN);
    return [];
  };
  await assert.rejects(runPilotAccess(f.args), (error) => {
    const report = error.pilotAccessReport;
    assert.equal(report.phase, 'pending_browser');
    assert.equal(report.verdict, 'failed_or_unknown');
    assert.equal(report.cleanup.pendingRequest, 'removed_and_absence_verified');
    assert.equal(report.cleanup.outsiderSession, 'local_signout_confirmed');
    assert.doesNotMatch(JSON.stringify(report), new RegExp(TOKEN));
    return true;
  });
  assert.equal(f.getRow(), null);
  assert.equal(f.operations.filter((name) => name === 'fn_cancel_club_join_request').length, 1);
  assert.deepEqual(f.calls.at(-1), ['signOut', { scope: 'local' }]);
});
test('exact same-operation persisted pending membership recovers cleanup only', async () => {
  const { runPilotAccess } = await import('./lightning-pilot-access.mjs');
  const member = {
    club_id: '00000000-0000-4000-8000-000000000010',
    user_id: PILOT_OUTSIDER,
    joined_at: '2026-10-16T17:10:29.040468+00:00',
    status: 'pending',
    chip_balance: 0,
  };
  const f = recoveryFixture(member);
  f.args.observeBrowser = async () => {
    throw new Error('Recovery Must Never Start Browser Proof');
  };
  await assert.rejects(runPilotAccess(f.args), (error) => {
    assert.equal(error.pilotAccessReport.verdict, 'cleanup_only');
    assert.equal(error.pilotAccessReport.phase, 'startup_owned_pending_recovery');
    assert.equal(error.pilotAccessReport.cleanup.pendingRequest, 'removed_and_absence_verified');
    assert.equal(error.pilotAccessReport.cleanup.outsiderSession, 'local_signout_confirmed');
    assert.deepEqual(error.pilotAccessReport.states, []);
    return true;
  });
  assert.equal(f.getRow(), null);
  assert.deepEqual(f.operations, ['fn_cancel_club_join_request']);
});
test('changed, funded, foreign or timestamp-mismatched pending ownership never cancels', async () => {
  const { runPilotAccess } = await import('./lightning-pilot-access.mjs');
  const member = {
    club_id: '00000000-0000-4000-8000-000000000010',
    user_id: PILOT_OUTSIDER,
    joined_at: '2026-10-16T17:10:29.040468+00:00',
    status: 'pending',
    chip_balance: 0,
  };
  for (const [rowPatch, receiptPatch] of [
    [{ chip_balance: 1 }, {}],
    [{ status: 'active' }, {}],
    [{}, { request_id: 'different-request' }],
    [{}, { user_id: 'different-user' }],
    [
      {},
      {
        result: {
          success: true,
          status: 'pending',
          club: { id: member.club_id },
          membership: { ...member, joined_at: '2026-10-16T17:10:29.040469+00:00' },
        },
      },
    ],
  ]) {
    const f = recoveryFixture({ ...member, ...rowPatch }, receiptPatch);
    await assert.rejects(runPilotAccess(f.args), (error) => {
      assert.equal(
        error.pilotAccessReport.cleanup.pendingRequest,
        'unowned_or_changed_no_cancellation'
      );
      return true;
    });
    assert.deepEqual(f.operations, []);
    assert.equal(f.calls.length, 0);
    assert.notEqual(f.getRow(), null);
  }
});
