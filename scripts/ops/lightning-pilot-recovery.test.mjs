import './recovery-phase-observation.test.mjs';
import './recovery-wire-observation.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import {
  recoveryFrame,
  initializeRecoverySession,
  observeRevokedConsumer,
  observeRevokedSocket,
  witnessRecovery,
  recoveryJournal,
  recoveryDiagnosticBudget,
} from './lightning-pilot-recovery.mjs';
import { observeRecoveryPhaseBracket } from './recovery-phase-observation.mjs';
const SECRET = 'TEST_PRIVATE_FRAME_AND_TOKEN';
const ROOM = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const HAND = '10000000-0000-4000-8000-000000000003';
const validatedTarget = (p) => ({
  templateName: p.clusterId === pins[0].clusterId ? 'action' : 'madness',
});
const PLAYER = '0097309f-2864-4d09-b02b-56bca012a9c3';
const pins = [
  {
    clubId: 'e14bc9f7-736d-425f-8f2c-e78305ebac1d',
    clusterId: 'babb43f1-368e-406f-a97a-a0d5013648b2',
    playerId: PLAYER,
    poolSessionId: ROOM,
  },
  {
    clubId: 'e14bc9f7-736d-425f-8f2c-e78305ebac1d',
    clusterId: '3330ff9f-76ec-4487-b0c9-fc8ad8c2fdbb',
    playerId: PLAYER,
    poolSessionId: OTHER,
  },
];
test('frame observer keeps only actual scoped producer identity and discards received cards', () => {
  const ack = recoveryFrame(
    JSON.stringify({ type: 'RENDER_ACK', tableId: ROOM, hand_id: HAND, token: SECRET }),
    'sent',
    [ROOM]
  );
  assert.deepEqual(ack, { type: 'RENDER_ACK', room: ROOM, handId: HAND });
  const snapshot = recoveryFrame(
    JSON.stringify({ type: 'SNAPSHOT', tableId: ROOM, state: { cards: SECRET } }),
    'received',
    [ROOM]
  );
  assert.deepEqual(snapshot, { type: 'SNAPSHOT', room: ROOM });
  assert.equal(
    recoveryFrame(JSON.stringify({ type: 'RENDER_ACK', tableId: OTHER, hand_id: HAND }), 'sent', [
      ROOM,
    ]),
    null
  );
  assert.equal(
    recoveryFrame(JSON.stringify({ type: 'RENDER_ACK', tableId: ROOM, hand_id: SECRET }), 'sent', [
      ROOM,
    ]),
    null
  );
  assert.equal(
    recoveryFrame(
      JSON.stringify({ type: 'RENDER_ACK', tableId: ROOM, hand_id: HAND }),
      'received',
      [ROOM]
    ),
    null
  );
  assert.doesNotMatch(JSON.stringify([ack, snapshot]), new RegExp(SECRET));
});
test('revoked session requires explicit auth close and never treats a network close as proof', async () => {
  for (const [code, expected] of [
    [4401, 'auth_refused'],
    [1006, 'unknown'],
  ]) {
    let terminated = false;
    class Socket extends EventEmitter {
      constructor(url, protocol, options) {
        super();
        assert.match(url, new RegExp(ROOM));
        assert.deepEqual(protocol, ['bearer', SECRET]);
        assert.equal(options.handshakeTimeout, 100);
        queueMicrotask(() => this.emit('close', code));
      }
      terminate() {
        terminated = true;
      }
    }
    assert.equal(await observeRevokedSocket(Socket, ROOM, SECRET, 100), expected);
    assert.equal(terminated, true);
  }
});
test('wrong identity, ambiguous sessions and unbounded duration refuse before auth', async () => {
  for (const patch of [
    { pins: [pins[0]] },
    { pins: [pins[0], pins[0]] },
    { pins: pins.map((p) => ({ ...p, playerId: OTHER })) },
    { timeoutMs: 240001 },
  ]) {
    let opened = false;
    const r = await witnessRecovery({
      pins,
      ...patch,
      openSession: async () => {
        opened = true;
      },
    });
    assert.equal(r.status, 'unknown');
    assert.equal(opened, false);
  }
});
test('two existing own sessions are mandatory and refusal closes only the created local session', async () => {
  const signouts = [],
    validated = [];
  let launched = false;
  const admin = {
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: { id: PLAYER, club_arena_tos_accepted_at: '2026-01-01' },
        }),
      };
      return q;
    },
  };
  const r = await witnessRecovery({
    admin,
    pins,
    chromium: {
      launch: async () => {
        launched = true;
      },
    },
    validate: async (_admin, pin) => {
      validated.push(pin);
      return validatedTarget(pin);
    },
    openSession: async () => ({
      session: { access_token: SECRET },
      client: {
        rpc: async () => ({ data: [{ pool_session_id: ROOM, cluster_id: pins[0].clusterId }] }),
        auth: {
          signOut: async (options) => {
            signouts.push(options);
            return {};
          },
        },
      },
    }),
  });
  assert.equal(r.status, 'unknown');
  assert.equal(launched, false);
  assert.equal(validated.length, 2);
  assert.deepEqual(signouts, [{ scope: 'local' }]);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
});
test('touch selectors and authoritative reconnect observations match maintained producer contracts', () => {
  const read = (path) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
  assert.match(read('src/components/table/TableTabBar.tsx'), /data-tabid=\{tab.id\}/);
  assert.match(read('src/components/table/TableTabBar.tsx'), /aria-current=\{isActive \? 'true'/);
  assert.match(
    read('src/services/EngineStateClient.ts'),
    /type: 'RENDER_ACK', tableId: this.opts.tableId, hand_id: handId/
  );
  assert.match(
    read('server/src/transport/TableStateHub.ts'),
    /message = \{ type: 'SNAPSHOT', tableId, seq: next, state: wireState \}/
  );
  const source = read('scripts/ops/lightning-pilot-recovery.mjs');
  assert.match(source, /hasTouch: true/);
  assert.match(source, /await tab.tap/);
  assert.match(source, /setOffline\(true\)/);
  assert.match(source, /setOffline\(false\)/);
  assert.doesNotMatch(source, /\.send\(|fn_cash_game_join|buyin|accept-tos|signOut\(\)/);
});

test('partial recovery authentication retains owned local-client cleanup', async () => {
  const signouts = [];
  const admin = {
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: { id: PLAYER, club_arena_tos_accepted_at: '2026-01-01' },
        }),
      };
      return q;
    },
  };
  const r = await witnessRecovery({
    admin,
    pins,
    validate: async (_admin, pin) => validatedTarget(pin),
    createClient: () => ({
      auth: {
        signOut: async (value) => {
          signouts.push(value);
          return {};
        },
      },
    }),
    openSession: async (_admin, factory) => {
      factory('https://example.invalid', 'public');
      throw new Error(SECRET);
    },
  });
  assert.equal(r.status, 'unknown');
  assert.deepEqual(signouts, [{ scope: 'local' }]);
  assert.equal(r.cleanup, 'local_sessions_and_browser_closed');
  assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
});

test('normal revoked consumer must redirect itself with its session cleared after a real transport drop', async () => {
  const calls = [],
    socket = { closed: false };
  const context = {
    setOffline: async (offline) => {
      calls.push(offline);
      if (offline) socket.closed = true;
    },
  };
  const evidence = {
    sockets: [socket],
    socketsFor: (room) => {
      assert.equal(room, ROOM);
      return [socket];
    },
    wait: async (predicate) => assert.equal(predicate(), true),
  };
  const page = {
    waitForURL: async (predicate) => {
      assert.equal(
        predicate(new URL('https://smarter.poker/auth/login?authError=no_session')),
        true
      );
      assert.equal(predicate(new URL('https://smarter.poker/auth/login')), false);
      assert.equal(
        predicate(new URL('https://example.invalid/auth/login?authError=no_session')),
        false
      );
    },
    evaluate: async () => true,
  };
  assert.deepEqual(await observeRevokedConsumer(page, context, evidence, () => 1000, ROOM), {
    redirect: 'observed',
    localSessionCleared: true,
  });
  assert.deepEqual(calls, [true, false]);
  socket.closed = false;
  page.evaluate = async () => false;
  await assert.rejects(
    observeRevokedConsumer(page, context, evidence, () => 1000, ROOM),
    /Session Remains/
  );
});

test('synthetic initialization never reinstates a cleared session on the normal login redirect', () => {
  const local = new Map(),
    tab = new Map();
  const storage = (map) => ({
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
  });
  const sandbox = {
    location: { origin: 'https://smarter.poker' },
    localStorage: storage(local),
    sessionStorage: storage(tab),
    session: { access_token: SECRET },
  };
  const script = '(' + initializeRecoverySession.toString() + ')({session})';
  runInNewContext(script, sandbox);
  assert.equal(local.has('smarter-poker-auth'), true);
  local.delete('smarter-poker-auth');
  runInNewContext(script, sandbox);
  assert.equal(local.has('smarter-poker-auth'), false);
});

test('revoked consumer contract belongs to maintained session owner and login route', () => {
  const read = (path) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
  const consumer = read('src/lib/sessionRevoked.ts');
  assert.match(
    consumer,
    /signInUrl\(pathname \+ \(search \|\| ''\), \{ authError: 'no_session' \}\)/
  );
  assert.match(consumer, /supabase.auth.signOut\(\{ scope: 'local' \}\)/);
  assert.match(consumer, /localStorage.removeItem\(AUTH_STORAGE_KEY\)/);
  assert.match(read('src/lib/signIn.ts'), /auth\/login/);
});

test('one normal disconnect is bracketed in order and never closes unobserved phases', async () => {
  const order = [];
  let reads = 0;
  const result = await observeRecoveryPhaseBracket({
    capture: async () => {
      order.push('read');
      return {
        status: 'observed',
        phase: reads++ ? 'idle' : 'reservation',
        ...pins[1],
        handId: null,
        startedAt: reads === 1 ? 100 : 200,
        endedAt: reads === 1 ? 110 : 210,
      };
    },
    disconnect: async () => {
      order.push('disconnect');
      return { offlineStartedAt: 120, onlineStartedAt: 190 };
    },
  });
  assert.deepEqual(order, ['read', 'disconnect', 'read']);
  assert.equal(result.bracket.status, 'observed');
  assert.deepEqual(result.coverage, {
    idle: 'unknown',
    reservation: 'observed',
    dealing: 'unknown',
  });
});
test('missing phase remains unknown without retrying or changing normal reconnect outcome', async () => {
  let calls = 0;
  const result = await observeRecoveryPhaseBracket({
    capture: async () => ({ status: 'unknown', phase: 'unknown' }),
    disconnect: async () => {
      calls++;
      return { offlineStartedAt: 120, onlineStartedAt: 190 };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.bracket.status, 'unknown');
  assert.deepEqual(result.coverage, {
    idle: 'unknown',
    reservation: 'unknown',
    dealing: 'unknown',
  });
});

test('Samantha uses her own prior-consent profile; no new consent is written', async () => {
  const samantha = 'a23ca5c9-b748-482f-9b59-9db35f7aa996';
  for (const accepted of [false, true]) {
    let opened = false;
    const admin = {
      from: (table) => {
        assert.equal(table, 'profiles');
        const q = {
          select: () => q,
          eq: (key, value) => {
            assert.equal(key, 'id');
            assert.equal(value, samantha);
            return q;
          },
          maybeSingle: async () => ({
            data: { id: samantha, club_arena_tos_accepted_at: accepted ? '2026-01-01' : null },
          }),
        };
        return q;
      },
      rpc: async () => ({ error: true }),
    };
    const report = await witnessRecovery({
      admin,
      pins: pins.map((p) => ({ ...p, playerId: samantha })),
      validate: async (_admin, pin) => validatedTarget(pin),
      openSession: async () => {
        opened = true;
        throw new Error('fixture');
      },
    });
    assert.equal(opened, accepted);
    assert.equal(report.status, 'unknown');
  }
});

test('recovery refuses mixed approved player identities before profile or auth reads', async () => {
  let reads = 0;
  const report = await witnessRecovery({
    pins: [pins[0], { ...pins[1], playerId: 'a23ca5c9-b748-482f-9b59-9db35f7aa996' }],
    admin: {
      from: () => {
        reads++;
        throw new Error();
      },
    },
    validate: async () => {
      reads++;
    },
    openSession: async () => {
      reads++;
    },
  });
  assert.equal(report.status, 'unknown');
  assert.equal(reads, 0);
});

test('two distinct UUIDs resolving to the same target category refuse before profile or session authentication', async () => {
  let authReads = 0;
  const report = await witnessRecovery({
    pins,
    validate: async () => ({ templateName: 'action' }),
    admin: {
      from: () => {
        authReads++;
        throw new Error();
      },
    },
    openSession: async () => {
      authReads++;
      throw new Error();
    },
  });
  assert.equal(report.status, 'unknown');
  assert.equal(authReads, 0);
});

function manualRecoveryFixture({
  missingAdd = false,
  duplicateChosen = false,
  existingOther = false,
  ambiguousTab = false,
  hiddenTab = false,
  initialTabState = 'visible',
} = {}) {
  const events = new EventEmitter(),
    tabs = new Set(),
    calls = [];
  const table = '10000000-0000-4000-8000-000000000009';
  let active,
    phaseReads = 0,
    lobby = false;
  const publish = (room) => {
    const ws = new EventEmitter();
    ws.url = () => 'wss://engine.smarter.poker/ws';
    events.emit('websocket', ws);
    for (const [name, type] of [
      ['framesent', 'SUBSCRIBE'],
      ['framereceived', 'SUBSCRIBED'],
      ['framereceived', 'SNAPSHOT'],
      ['framesent', 'RENDER_ACK'],
    ])
      ws.emit(name, { payload: JSON.stringify({ type, tableId: room, hand_id: HAND }) });
  };
  const initial = (selector) => selector.includes('data-tabid') && selector.includes(ROOM);
  const loc = (selector) => ({
    first: () => loc(selector),
    count: async () =>
      initial(selector) && initialTabState !== 'visible'
        ? initialTabState === 'ambiguous'
          ? 2
          : initialTabState === 'missing'
            ? 0
            : 1
        : selector === 'add' && missingAdd
          ? 0
          : selector.includes('data-tabid')
            ? ambiguousTab && selector.includes(OTHER)
              ? 2
              : Number(tabs.has(selector.match(/"([^"]+)"/)[1]))
            : 1,
    isVisible: async () =>
      !(initial(selector) && initialTabState === 'hidden') &&
      !(hiddenTab && selector.includes(OTHER)),
    waitFor: async () => {
      if (initial(selector) && ['missing', 'hidden'].includes(initialTabState))
        throw Error('Tab Not Visible');
    },
    evaluateAll: async () => [table],
    getAttribute: async () => (selector.includes(active) ? 'true' : null),
    getByRole: (_role, options) => loc(options.name === 'Open Lobby' ? 'open_lobby' : 'view'),
    click: async (options) => {
      calls.push([selector, options?.button]);
      if (selector === 'add') assert.equal(options.button, 'right');
      if (selector === 'open_lobby') lobby = true;
      if (selector === 'view') {
        assert.equal(lobby, true);
        tabs.add(OTHER);
        active = OTHER;
        publish(OTHER);
        if (duplicateChosen) publish(OTHER);
      }
    },
    tap: async () => {
      const room = selector.match(/"([^"]+)"/)[1];
      if (!tabs.has(room)) throw Error('Missing Tab');
      active = room;
    },
  });
  const page = {
    on: (...args) => events.on(...args),
    goto: async (url) => {
      calls.push(['goto']);
      tabs.clear();
      const room = url.includes(pins[0].clusterId) ? ROOM : OTHER;
      tabs.add(room);
      active = room;
      publish(room);
      if (existingOther) {
        tabs.add(OTHER);
        publish(OTHER);
      }
    },
    locator: loc,
    getByRole: (_role, options) => loc(options.name === 'Open Another Table' ? 'add' : 'menu'),
    setViewportSize: async () => {},
    evaluate: async () => ({ route: 'table', layer: 'none' }),
  };
  const admin = {
    from: (tableName) => {
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        limit: () => q,
        maybeSingle: async () => ({
          data: { id: PLAYER, club_arena_tos_accepted_at: '2026-01-01' },
        }),
        then: (resolve) =>
          Promise.resolve({
            data:
              tableName === 'tables'
                ? [{ id: table, cluster_id: pins[1].clusterId, club_id: pins[1].clubId }]
                : [],
          }).then(resolve),
      };
      return q;
    },
  };
  return {
    calls,
    phaseReads: () => phaseReads,
    args: {
      admin,
      pins,
      validate: async (_a, pin) => validatedTarget(pin),
      openSession: async () => ({
        session: {},
        client: {
          rpc: async () => ({
            data: pins.map((p) => ({ pool_session_id: p.poolSessionId, cluster_id: p.clusterId })),
          }),
          auth: { signOut: async () => ({}) },
        },
      }),
      chromium: {
        launch: async () => ({
          newContext: async () => ({ addInitScript: async () => {}, newPage: async () => page }),
          close: async () => {},
        }),
      },
      capturePhase: async () => {
        phaseReads++;
        throw Error('Stop After Scoped Transport');
      },
    },
  };
}
test('one initial document plus normal secondary lobby View Game preserves both tabs and scopes two sockets', async () => {
  const f = manualRecoveryFixture();
  const report = await witnessRecovery(f.args);
  assert.equal(f.calls.filter(([kind]) => kind === 'goto').length, 1);
  assert.equal(report.touch.length, 4);
  assert.equal(f.phaseReads(), 1);
  assert.equal(report.phase, 'disconnect');
  assert.equal(report.status, 'unknown');
  assert.equal(report.cleanup, 'local_sessions_and_browser_closed');
  assert.doesNotMatch(JSON.stringify(report), /token|PRIVATE|cards/);
});
test('absent add control refuses without a second navigation, join or closing any game', async () => {
  const f = manualRecoveryFixture({ missingAdd: true });
  const report = await witnessRecovery(f.args);
  assert.equal(f.calls.filter(([kind]) => kind === 'goto').length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(report.navigation.at(-1).step, 'open_another_table_unavailable');
  assert.equal(report.cleanup, 'local_sessions_and_browser_closed');
});
test('already restored target pool uses its normal tab even when add control is absent at capacity', async () => {
  const f = manualRecoveryFixture({ existingOther: true, missingAdd: true });
  const report = await witnessRecovery(f.args);
  assert.equal(f.calls.length, 1);
  assert.equal(report.touch.length, 4);
  assert.equal(f.phaseReads(), 1);
  assert.equal(report.cleanup, 'local_sessions_and_browser_closed');
});
test('ambiguous target tab refuses before another menu or navigation gesture', async () => {
  const f = manualRecoveryFixture({ existingOther: true, ambiguousTab: true });
  const report = await witnessRecovery(f.args);
  assert.equal(f.calls.length, 1);
  assert.equal(report.touch.length, 0);
  assert.equal(report.navigation.at(-1).step, 'find_existing_pool_tab');
  assert.equal(report.status, 'unknown');
});
test('a hidden existing target tab refuses without opening another lobby or changing capacity', async () => {
  const f = manualRecoveryFixture({ existingOther: true, hiddenTab: true });
  const report = await witnessRecovery(f.args);
  assert.equal(f.calls.length, 1);
  assert.equal(report.touch.length, 0);
  assert.equal(report.navigation.at(-1).step, 'existing_pool_tab_hidden');
  assert.equal(report.cleanup, 'local_sessions_and_browser_closed');
});
test('two simultaneous owners of chosen pool still refuse despite legitimate other pool socket', async () => {
  const f = manualRecoveryFixture({ duplicateChosen: true });
  const report = await witnessRecovery(f.args);
  assert.equal(report.touch.length, 4);
  assert.equal(f.phaseReads(), 0);
  assert.equal(report.reconnect, 'unknown');
});
test('multiplexed socket retains each independently subscribed room and unacknowledged rooms are not owners', () => {
  const page = new EventEmitter();
  const evidence = recoveryJournal(page, [ROOM, OTHER], () => 1000, PLAYER);
  const socket = new EventEmitter();
  socket.url = () => 'wss://engine.smarter.poker/ws?token=SECRET';
  page.emit('websocket', socket);
  const frame = (direction, type, tableId) =>
    socket.emit(direction, { payload: JSON.stringify({ type, tableId }) });
  frame('framesent', 'SUBSCRIBE', ROOM);
  assert.equal(evidence.socketsFor(ROOM).length, 0);
  frame('framereceived', 'SUBSCRIBED', ROOM);
  frame('framesent', 'SUBSCRIBE', OTHER);
  frame('framereceived', 'SUBSCRIBED', OTHER);
  assert.equal(evidence.socketsFor(ROOM).length, 1);
  assert.equal(evidence.socketsFor(OTHER).length, 1);
  assert.equal(evidence.socketsFor(ROOM)[0], evidence.socketsFor(OTHER)[0]);
  frame('framesent', 'UNSUBSCRIBE', ROOM);
  assert.equal(evidence.socketsFor(ROOM).length, 0);
  assert.equal(evidence.socketsFor(OTHER).length, 1);
  socket.emit('close');
  assert.equal(evidence.socketsFor(ROOM).length, 0);
  assert.doesNotMatch(JSON.stringify(evidence.frames), /SECRET|token/);
});
test('failure UI diagnostics use only the existing cleanup reserve and retain a signout margin', () => {
  assert.equal(recoveryDiagnosticBudget(1000, 240000, 221001), 1500);
  assert.equal(recoveryDiagnosticBudget(1000, 240000, 230500), 500);
  assert.equal(recoveryDiagnosticBudget(1000, 240000, 241000), 1);
});

test('initial, duplicate and replacement contexts manually select their restored pool before scoped render', async () => {
  const base = manualRecoveryFixture();
  const pages = [],
    sessions = [];
  class RefusedSocket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('close', 4401));
    }
    terminate() {}
  }
  const report = await witnessRecovery({
    ...base.args,
    timeoutMs: 30000,
    WebSocket: RefusedSocket,
    openSession: async () => {
      const session = { revoked: false };
      sessions.push(session);
      return {
        session,
        client: {
          rpc: async () => ({
            data: pins.map((p) => ({ pool_session_id: p.poolSessionId, cluster_id: p.clusterId })),
          }),
          auth: {
            signOut: async () => {
              session.revoked = true;
              return {};
            },
          },
        },
      };
    },
    capturePhase: async () => ({ status: 'unknown', phase: 'unknown' }),
    chromium: {
      launch: async () => ({
        close: async () => {},
        newContext: async () => {
          const events = new EventEmitter(),
            sockets = [];
          let session,
            active = HAND;
          const taps = [],
            waits = [];
          const publish = (room) => {
            const ws = new EventEmitter();
            sockets.push(ws);
            ws.url = () => 'wss://engine.smarter.poker/ws';
            events.emit('websocket', ws);
            for (const [name, type] of [
              ['framesent', 'SUBSCRIBE'],
              ['framereceived', 'SUBSCRIBED'],
              ['framereceived', 'SNAPSHOT'],
              ['framesent', 'RENDER_ACK'],
            ])
              ws.emit(name, { payload: JSON.stringify({ type, tableId: room, hand_id: HAND }) });
          };
          const page = {
            on: (...a) => events.on(...a),
            goto: async () => {
              active = HAND;
            },
            locator: (selector) => {
              const room = selector.match(/"([^"]+)"/)[1];
              return {
                waitFor: async (options) => {
                  assert.equal(options.state, 'visible');
                  waits.push(room);
                },
                count: async () => Number([ROOM, OTHER].includes(room)),
                isVisible: async () => true,
                getAttribute: async () => String(active === room),
                tap: async () => {
                  assert.ok(waits.includes(room), 'actual visibility awaited before tap');
                  taps.push(room);
                  active = room;
                  if (
                    !sockets.length ||
                    (room === OTHER && taps.filter((r) => r === OTHER).length === 1)
                  )
                    publish(room);
                },
              };
            },
            setViewportSize: async () => {},
            waitForURL: async () => {
              assert.equal(session.revoked, true);
            },
            evaluate: async () => session.revoked,
          };
          const context = {
            addInitScript: async (_fn, args) => {
              session = args.session;
            },
            newPage: async () => page,
            close: async () => {
              for (const ws of sockets.splice(0)) ws.emit('close');
            },
            setOffline: async (offline) => {
              if (offline) {
                for (const ws of sockets.splice(0)) ws.emit('close');
                // Distinct actual outage times keep old subscription receipts outside reconnect.
                await new Promise((resolve) => setTimeout(resolve, 2));
              } else if (!session.revoked) publish(active);
            },
          };
          pages.push({ taps, waits });
          return context;
        },
      }),
    },
  });
  assert.equal(report.status, 'observed', JSON.stringify({ report, pages }));
  assert.equal(report.duplicate, 'second_connection_rendered_same_pool');
  assert.equal(report.recovery, 'new_local_session_same_pool_rendered');
  assert.equal(pages.length, 3);
  assert.equal(pages[0].taps[0], ROOM);
  assert.equal(pages[1].taps[0], OTHER);
  assert.equal(pages[2].taps[0], OTHER);
  assert.equal(report.cleanup, 'local_sessions_and_browser_closed');
});

for (const initialTabState of ['missing', 'hidden', 'ambiguous']) {
  test(`initial ${initialTabState} pool tab remains unknown before menus or render claims`, async () => {
    const fixture = manualRecoveryFixture({ initialTabState });
    const report = await witnessRecovery(fixture.args);
    assert.equal(report.status, 'unknown');
    assert.equal(report.touch.length, 0);
    assert.notEqual(report.navigation[0].step, 'rendered');
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.phaseReads(), 0);
    assert.equal(report.cleanup, 'local_sessions_and_browser_closed');
  });
}

test('the second pool opens through View Game or a seated Return To, never Join or a waitlist', () => {
  const src = readFileSync(new URL('./lightning-pilot-recovery.mjs', import.meta.url), 'utf8');
  const door = src.slice(src.indexOf('async function openOtherPool'));
  const body = door.slice(0, door.indexOf('\n}\n') + 2);
  assert.match(body, /name: \/\^View Game \//);
  assert.match(body, /name: \/\^Return To \//);
  const lookups = body.match(/getByRole\('button', \{ name: [^}]+\}/g) ?? [];
  assert.ok(lookups.length >= 2);
  for (const l of lookups) assert.doesNotMatch(l, /Join|Sit|Waitlist/);
});
