import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openDesignatedOutsiderSession,
  PILOT_OUTSIDER,
  socketAccess,
  browserAccess,
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
      select: () => q,
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
      select: () => q,
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
