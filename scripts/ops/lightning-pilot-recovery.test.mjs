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
} from './lightning-pilot-recovery.mjs';
import { observeRecoveryPhaseBracket } from './recovery-phase-observation.mjs';
const SECRET = 'TEST_PRIVATE_FRAME_AND_TOKEN';
const ROOM = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const HAND = '10000000-0000-4000-8000-000000000003';
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
    validate: async (_admin, pin) => validated.push(pin),
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
    validate: async () => {},
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
  assert.deepEqual(await observeRevokedConsumer(page, context, evidence, () => 1000), {
    redirect: 'observed',
    localSessionCleared: true,
  });
  assert.deepEqual(calls, [true, false]);
  socket.closed = false;
  page.evaluate = async () => false;
  await assert.rejects(
    observeRevokedConsumer(page, context, evidence, () => 1000),
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
