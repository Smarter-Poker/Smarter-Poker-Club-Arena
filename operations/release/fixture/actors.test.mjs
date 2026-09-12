// Native loopback transport boundary tests. These protocol fixtures do not
// qualify a candidate engine, the full fixture schema, or a live hand.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { startFixtureActors } from './actors.mjs';

const { WebSocketServer } = createRequire(import.meta.url)('ws');
const tableId = '11111111-1111-4111-8111-111111111111';
const ids = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const spectatorId = '44444444-4444-4444-8444-444444444444';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'boundary fixture timed out');
    await wait(10);
  }
}
function token(id) {
  const encoded = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');
  const text = `${encoded({ alg: 'HS256' })}.${encoded({ sub: id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  return `${text}.${createHmac('sha256', 'local-protocol-boundary-only').update(text).digest('base64url')}`;
}
const users = ids.map((id) => ({
  id,
  session: { user: { id }, access_token: token(id) },
}));
function snapshot(current = null, context = null) {
  return {
    table_id: tableId,
    hand_number: 1,
    stage: current ? 'preflop' : 'waiting',
    current_player: current,
    action_context: context,
    current_bet: 0,
    pot: 0,
    players: ids.map((id, i) => ({
      user_id: id,
      seat: i + 1,
      stack: 100,
      bet: 0,
      is_folded: false,
      is_all_in: false,
    })),
  };
}

async function harness(
  t,
  {
    state = snapshot(),
    response = () => [200, { success: true }],
    subprotocol = 'bearer',
    financialProof,
    financialResponse = () => [400, { success: false }],
    signal,
    replyToSubscribe = true,
  } = {}
) {
  const actions = [],
    financialRequests = [],
    frames = [],
    sockets = new Map(),
    failures = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const actor = users.find(
      (user) => req.headers.authorization === `Bearer ${user.session.access_token}`
    );
    assert.ok(actor);
    if (req.url !== '/action') {
      financialRequests.push({ method: req.method, url: req.url, body, actor: actor.id });
      const [code, result] = financialResponse(financialRequests.at(-1));
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    assert.equal(req.method, 'POST');
    actions.push({ ...body, actor: actor.id, at: Date.now() });
    const [status, result] = response(actions.at(-1), actions.length);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof result === 'string' ? result : JSON.stringify(result));
  });
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: () => subprotocol,
  });
  server.on('upgrade', (req, socket, head) => {
    assert.equal(req.url, '/ws/multi?v=0');
    assert.ok(req.headers['sec-websocket-protocol'].startsWith('bearer,'));
    const offered = req.headers['sec-websocket-protocol'].split(',').map((x) => x.trim());
    const actor = users.find((user) => offered.includes(user.session.access_token));
    assert.ok(actor);
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.set(actor.id, ws);
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw));
        frames.push(frame);
        assert.ok(['SUBSCRIBE', 'PONG'].includes(frame.type), 'WS never transports actions');
        if (frame.type === 'SUBSCRIBE' && replyToSubscribe) {
          assert.equal(frame.tableId, tableId);
          ws.send(JSON.stringify({ type: 'SNAPSHOT', tableId, seq: 1, state }));
          ws.send(JSON.stringify({ type: 'SUBSCRIBED', tableId }));
        }
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  let runner;
  t.after(async () => {
    runner?.close();
    for (const ws of sockets.values()) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const start = () =>
    startFixtureActors({
      tableId,
      users,
      signal,
      ...(financialProof ? { financialProof } : {}),
      onFailure: (error) => failures.push(error.message),
      testEndpoints: {
        http: `http://127.0.0.1:${port}`,
        ws: `ws://127.0.0.1:${port}`,
      },
    }).then((value) => {
      runner = value;
      return value;
    });
  const send = (message, user = ids[0]) =>
    sockets.get(user).send(typeof message === 'string' ? message : JSON.stringify(message));
  const broadcast = (message) => {
    for (const id of ids) send(message, id);
  };
  return {
    start,
    send,
    broadcast,
    actions,
    financialRequests,
    failures,
    frames,
    sockets,
    close: () => runner?.close(),
  };
}

test('two native actors check/call/fold only through HTTP with exact contexts and unique keys', async (t) => {
  const fixture = await harness(t, { state: snapshot(ids[0], 'decision-one') });
  await fixture.start();
  await until(() => fixture.actions.length === 1);
  fixture.broadcast({
    type: 'DELTA',
    tableId,
    seq: 2,
    prev: 1,
    patch: [
      { op: 'replace', path: '/current_player', value: ids[1] },
      { op: 'replace', path: '/action_context', value: 'decision-two' },
      { op: 'replace', path: '/current_bet', value: 10 },
    ],
  });
  await until(() => fixture.actions.length === 2);
  fixture.broadcast({
    type: 'DELTA',
    tableId,
    seq: 3,
    prev: 2,
    patch: [
      { op: 'replace', path: '/current_player', value: ids[0] },
      { op: 'replace', path: '/action_context', value: 'decision-three' },
      { op: 'replace', path: '/players/0/stack', value: 5 },
    ],
  });
  await until(() => fixture.actions.length === 3);
  assert.deepEqual(
    fixture.actions.map((x) => [x.actor, x.action, x.actionContext]),
    [
      [ids[0], 'check', 'decision-one'],
      [ids[1], 'call', 'decision-two'],
      [ids[0], 'fold', 'decision-three'],
    ]
  );
  assert.equal(new Set(fixture.actions.map((x) => x.idempotencyKey)).size, 3);
  assert.ok(fixture.actions.every((x) => x.tableId === tableId && !('amount' in x)));
  assert.ok(fixture.actions[2].at - fixture.actions[0].at >= 350);
  assert.deepEqual(fixture.failures, []);
});

test('financial actor transports top-up replay and offer acceptance over authenticated HTTP exactly once', async (t) => {
  // Loopback protocol fixture only: this does not claim a real engine-generated
  // insurance offer, funded settlement, or actual GoTrue session.
  const checkpoints = [];
  const h = await harness(t, {
    state: snapshot(ids[0], 'preflop-one'),
    financialProof: {
      opId: 'bounded-topup-01',
      checkpoint: async (item) => checkpoints.push(item),
    },
    financialResponse: ({ url, body }) => {
      if (url === '/addchips')
        return body.opId === ''
          ? [400, { success: false }]
          : [200, { success: true, queued: true, applied: 10 }];
      if (url.startsWith('/insurance-preview?'))
        return [200, { success: true, premium: 4, insuredAmount: 100 }];
      assert.equal(url, '/insurance');
      return typeof body.coveragePercent === 'string'
        ? [400, { success: false }]
        : [200, { success: true, status: 'accepted', premium: 4, insuredAmount: 100 }];
    },
  });
  const runner = await h.start();
  await until(() => h.actions.length === 1);
  h.broadcast({
    type: 'SNAPSHOT',
    tableId,
    seq: 2,
    state: { ...snapshot(ids[1], 'turn-one'), stage: 'turn' },
  });
  await until(() => h.actions.length === 2);
  assert.deepEqual(
    h.actions.map((x) => x.action),
    ['check', 'all_in']
  );
  const payload = {
    type: 'insurance_offers',
    table_id: tableId,
    hand_number: 1,
    street: 'turn',
    board: ['Ah', 'Kd', '7s', '2c'],
    pot: 200,
    deadlineAt: Date.now() + 10000,
    offers: [{ playerId: ids[1], fullPremium: 4 }],
  };
  h.broadcast({ type: 'EVENT', tableId, payload });
  await until(() => checkpoints.some((x) => x.phase === 'insurance.accepted'));
  h.broadcast({
    type: 'EVENT',
    tableId,
    payload: { type: 'hand_complete', table_id: tableId, hand_number: 1 },
  });
  await until(() => runner.financialObservations().length === 8);
  assert.equal(h.financialRequests.length, 7);
  assert.deepEqual(
    h.financialRequests.slice(1, 3).map((x) => x.body),
    [
      { tableId, amount: 10, opId: 'bounded-topup-01' },
      { tableId, amount: 10, opId: 'bounded-topup-01' },
    ]
  );
  assert.ok(h.financialRequests.slice(0, 3).every((x) => x.actor === ids[0]));
  assert.ok(h.financialRequests.slice(3).every((x) => x.actor === ids[1]));
  assert.equal(
    new URL(h.financialRequests[3].url, 'http://fixture').searchParams.get('coveragePercent'),
    '100'
  );
  h.broadcast({
    type: 'SNAPSHOT',
    tableId,
    seq: 3,
    state: { ...snapshot(ids[0], 'next-hand'), hand_number: 2 },
  });
  await wait(500);
  assert.equal(h.actions.length, 2, 'financial sequence must not begin a second hand');
  const states = runner.stateObservations();
  assert.deepEqual(
    states.map((row) => row.actor_id),
    ids
  );
  assert.ok(states.every((row) => row.sequence === 3 && row.state.hand_number === 2));
  states[0].state.players[0].stack = 0;
  assert.ok(runner.stateObservations()[0].state.players[0].stack > 0);
  assert.ok(!JSON.stringify(states).includes('access_token'));
  assert.deepEqual(h.failures, []);
});

test('a failed financial checkpoint stops play before a top-up request is sent', async (t) => {
  const h = await harness(t, {
    state: snapshot(ids[0], 'first-decision'),
    financialProof: {
      opId: 'bounded-topup-01',
      checkpoint: async () => {
        throw new Error('observer refused');
      },
    },
  });
  await h.start();
  await until(() => h.failures.length === 1);
  assert.deepEqual(h.financialRequests, []);
  assert.deepEqual(h.actions, []);
});

test('duplicate snapshot and metadata delta cannot submit one decision twice', async (t) => {
  const state = snapshot(ids[0], 'one-decision');
  const fixture = await harness(t, { state });
  await fixture.start();
  fixture.send({ type: 'SNAPSHOT', tableId, seq: 1, state });
  fixture.send({
    type: 'DELTA',
    tableId,
    seq: 2,
    prev: 1,
    patch: [{ op: 'replace', path: '/pot', value: 12 }],
  });
  await until(() => fixture.actions.length === 1);
  await wait(500);
  assert.equal(fixture.actions.length, 1);
  assert.deepEqual(fixture.failures, []);
});

test('actors continue through a completed hand into the next fresh decision', async (t) => {
  const fixture = await harness(t, { state: snapshot(ids[0], 'hand-one-turn') });
  await fixture.start();
  await until(() => fixture.actions.length === 1);
  fixture.broadcast({
    type: 'SNAPSHOT',
    tableId,
    seq: 2,
    state: { ...snapshot(), stage: 'showdown' },
  });
  fixture.broadcast({ type: 'EVENT', tableId, payload: { type: 'hand_complete', hand_number: 1 } });
  fixture.broadcast({
    type: 'SNAPSHOT',
    tableId,
    seq: 3,
    state: { ...snapshot(ids[1], 'hand-two-turn'), hand_number: 2 },
  });
  await until(() => fixture.actions.length === 2);
  assert.equal(fixture.actions[1].actor, ids[1]);
  assert.equal(fixture.actions[1].actionContext, 'hand-two-turn');
  assert.notEqual(fixture.actions[0].idempotencyKey, fixture.actions[1].idempotencyKey);
  assert.deepEqual(fixture.failures, []);
});

test('a changed decision during pacing replaces the unsent intent', async (t) => {
  const fixture = await harness(t, { state: snapshot(ids[0], 'old-context') });
  await fixture.start();
  fixture.send({
    type: 'DELTA',
    tableId,
    seq: 2,
    prev: 1,
    patch: [{ op: 'replace', path: '/action_context', value: 'new-context' }],
  });
  await until(() => fixture.actions.length === 1);
  assert.equal(fixture.actions[0].actionContext, 'new-context');
  assert.deepEqual(fixture.failures, []);
});

test('PING is answered; animation/user events never become a decision', async (t) => {
  const fixture = await harness(t);
  await fixture.start();
  fixture.send({ type: 'PING', ts: 1234 });
  fixture.send({
    type: 'EVENT',
    tableId,
    payload: {
      type: 'turn_change',
      user_id: ids[0],
      action_context: 'not-a-snapshot',
    },
  });
  fixture.send({
    type: 'USER_EVENT',
    tableId,
    payload: { type: 'hole_cards', cards: ['As', 'Ks'] },
  });
  await until(() => fixture.frames.some((x) => x.type === 'PONG'));
  assert.deepEqual(
    fixture.frames.find((x) => x.type === 'PONG'),
    { type: 'PONG', ts: 1234 }
  );
  assert.equal(fixture.actions.length, 0);
  assert.deepEqual(fixture.failures, []);
});

for (const [name, message, expected] of [
  ['unknown protocol', { type: 'MAYBE_ACTION', tableId }, 'UNKNOWN_FRAME'],
  ['wrong table', { type: 'SUBSCRIBED', tableId: spectatorId }, 'WRONG_TABLE'],
  ['server refusal', { type: 'ERROR', tableId, code: 'AUTH_DENIED' }, 'ENGINE_ERROR'],
  ['malformed JSON', '{broken', 'PROTOCOL'],
  ['sequence gap', { type: 'DELTA', tableId, seq: 3, prev: 2, patch: [] }, 'SEQUENCE'],
  [
    'prototype patch',
    {
      type: 'DELTA',
      tableId,
      seq: 2,
      prev: 1,
      patch: [{ op: 'add', path: '/__proto__/polluted', value: true }],
    },
    'PATCH_PROTOTYPE',
  ],
  [
    'unsupported patch',
    {
      type: 'DELTA',
      tableId,
      seq: 2,
      prev: 1,
      patch: [{ op: 'move', path: '/pot', from: '/hand_number' }],
    },
    'PATCH',
  ],
  ['missing context', { type: 'SNAPSHOT', tableId, seq: 2, state: snapshot(ids[0]) }, 'CONTEXT'],
  [
    'spectator enters roster',
    {
      type: 'SNAPSHOT',
      tableId,
      seq: 2,
      state: {
        ...snapshot(),
        players: [{ user_id: ids[0] }, { user_id: spectatorId }],
      },
    },
    'ROSTER',
  ],
]) {
  test(`${name} fails closed and stops both native actors`, async (t) => {
    const fixture = await harness(t);
    await fixture.start();
    fixture.send(message);
    await until(() => fixture.failures.length === 1);
    assert.deepEqual(fixture.failures, [`FIXTURE_ACTOR_${expected}`]);
    await until(() => [...fixture.sockets.values()].every((ws) => ws.readyState === 3));
    assert.equal(fixture.actions.length, 0);
    assert.equal({}.polluted, undefined);
  });
}

for (const [name, status, body, expected] of [
  ['HTTP 429', 429, { success: false }, 'ACTION_HTTP'],
  ['HTTP 400', 400, { success: false }, 'ACTION_HTTP'],
  ['engine rejection', 200, { success: false, code: 'ACTION_CONTEXT_REQUIRED' }, 'ACTION_REJECTED'],
  ['unexpected replay', 200, { success: true, replayed: true }, 'ACTION_REJECTED'],
  ['invalid action JSON', 200, '{no', 'ACTION_TRANSPORT'],
]) {
  test(`${name} is one failed attempt without fallback/retry`, async (t) => {
    const fixture = await harness(t, {
      state: snapshot(ids[0], 'failed-once'),
      response: () => [status, body],
    });
    await fixture.start();
    await until(() => fixture.failures.length === 1);
    await wait(400);
    assert.deepEqual(fixture.failures, [`FIXTURE_ACTOR_${expected}`]);
    assert.equal(fixture.actions.length, 1);
  });
}

test('socket death reports one failure and shuts down the other actor', async (t) => {
  const fixture = await harness(t);
  await fixture.start();
  fixture.sockets.get(ids[0]).terminate();
  await until(() => fixture.failures.length === 1);
  assert.match(fixture.failures[0], /^FIXTURE_ACTOR_SOCKET_(CLOSED|ERROR)$/);
  await until(() => fixture.sockets.get(ids[1]).readyState === 3);
});

test('explicit close stops queued actions without reporting fixture failure', async (t) => {
  const fixture = await harness(t, {
    state: snapshot(ids[0], 'must-not-send'),
  });
  await fixture.start();
  fixture.close();
  await wait(450);
  assert.equal(fixture.actions.length, 0);
  assert.deepEqual(fixture.failures, []);
});

test('an observer abort stops both real sockets and their queued actions', async (t) => {
  const controller = new AbortController();
  const fixture = await harness(t, {
    signal: controller.signal,
    state: snapshot(ids[0], 'aborted-action'),
  });
  await fixture.start();
  controller.abort();
  await until(() => [...fixture.sockets.values()].every((socket) => socket.readyState === 3));
  await wait(350);
  assert.deepEqual(fixture.actions, []);
  assert.deepEqual(fixture.failures, []);
});

test('an observer abort interrupts actor startup without waiting for its startup timer', async (t) => {
  const controller = new AbortController();
  const fixture = await harness(t, { signal: controller.signal, replyToSubscribe: false });
  const starting = fixture.start();
  const refused = assert.rejects(starting, /FIXTURE_ACTOR_ABORTED/);
  await until(() => fixture.sockets.size === 2);
  controller.abort();
  await refused;
  await until(() => [...fixture.sockets.values()].every((socket) => socket.readyState === 3));
  assert.deepEqual(fixture.failures, []);
});

test('an already aborted observer cannot start an actor connection', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    startFixtureActors({ tableId, users, signal: controller.signal, onFailure() {} }),
    { name: 'AbortError' }
  );
});

test('only two matching authenticated sessions can start, endpoints remain local', async () => {
  const input = { tableId, users, onFailure() {} };
  await assert.rejects(startFixtureActors({ ...input, users: [...users, { id: spectatorId }] }));
  await assert.rejects(startFixtureActors({ ...input, users: [users[0], users[0]] }));
  await assert.rejects(
    startFixtureActors({
      ...input,
      users: [{ ...users[0], session: users[1].session }, users[1]],
    })
  );
  for (const http of [
    'http://engine.smarter.poker',
    'http://localhost:8080',
    'http://127.0.0.1:8080/path',
    'http://evil@127.0.0.1:8080',
    'https://127.0.0.1:8080',
  ]) {
    await assert.rejects(
      startFixtureActors({
        ...input,
        testEndpoints: { http, ws: 'ws://127.0.0.1:8080' },
      })
    );
  }
});
