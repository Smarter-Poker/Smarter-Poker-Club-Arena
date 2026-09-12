import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financialRoutePhase } from './financial-route-phase.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const bettingStages = new Set(['preflop', 'flop', 'turn', 'river']);
const stages = new Set(['waiting', ...bettingStages, 'showdown']);
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validMoney = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function protocol(ok, code) {
  if (!ok) throw new Error(`FIXTURE_ACTOR_${code}`);
}

function endpoints(testEndpoints) {
  if (testEndpoints === undefined) return { http: 'http://engine:8080', ws: 'ws://engine:8080' };
  protocol(
    record(testEndpoints) && Object.keys(testEndpoints).sort().join(',') === 'http,ws',
    'ENDPOINT'
  );
  const http = new URL(testEndpoints.http),
    ws = new URL(testEndpoints.ws);
  for (const endpoint of [http, ws]) {
    protocol(
      endpoint.hostname === '127.0.0.1' &&
        endpoint.port !== '' &&
        endpoint.pathname === '/' &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash,
      'ENDPOINT'
    );
  }
  protocol(http.protocol === 'http:' && ws.protocol === 'ws:' && http.port === ws.port, 'ENDPOINT');
  return { http: http.origin, ws: ws.origin };
}

// The server's fast-json-patch compare emits add/remove/replace. Unknown RFC6902
// operations fail closed; paths cannot traverse prototype keys or invent parents.
function patched(source, operations) {
  protocol(Array.isArray(operations) && operations.length <= 4096, 'PATCH');
  let result = structuredClone(source);
  for (const operation of operations) {
    protocol(
      record(operation) &&
        ['add', 'remove', 'replace'].includes(operation.op) &&
        typeof operation.path === 'string',
      'PATCH'
    );
    if (operation.op !== 'remove') protocol(own(operation, 'value'), 'PATCH');
    if (operation.path === '') {
      protocol(operation.op !== 'remove' && record(operation.value), 'PATCH_ROOT');
      result = structuredClone(operation.value);
      continue;
    }
    protocol(operation.path.startsWith('/'), 'PATCH_PATH');
    const parts = operation.path
      .slice(1)
      .split('/')
      .map((part) => {
        protocol(!/~(?:[^01]|$)/.test(part), 'PATCH_ESCAPE');
        const decoded = part.replaceAll('~1', '/').replaceAll('~0', '~');
        protocol(!unsafe.has(decoded), 'PATCH_PROTOTYPE');
        return decoded;
      });
    let parent = result;
    for (const key of parts.slice(0, -1)) {
      protocol((record(parent) || Array.isArray(parent)) && own(parent, key), 'PATCH_PARENT');
      parent = parent[key];
    }
    protocol(record(parent) || Array.isArray(parent), 'PATCH_PARENT');
    const key = parts.at(-1);
    if (Array.isArray(parent)) {
      const append = key === '-' && operation.op === 'add';
      protocol(append || /^(0|[1-9][0-9]*)$/.test(key), 'PATCH_INDEX');
      const index = append ? parent.length : Number(key);
      protocol(
        Number.isSafeInteger(index) &&
          index >= 0 &&
          index < parent.length + (operation.op === 'add' ? 1 : 0),
        'PATCH_INDEX'
      );
      if (operation.op === 'add') parent.splice(index, 0, structuredClone(operation.value));
      else if (operation.op === 'remove') parent.splice(index, 1);
      else parent[index] = structuredClone(operation.value);
    } else {
      if (operation.op !== 'add') protocol(own(parent, key), 'PATCH_MISSING');
      if (operation.op === 'remove') delete parent[key];
      else parent[key] = structuredClone(operation.value);
    }
  }
  return result;
}

function stateShape(state, tableId, actorIds) {
  protocol(record(state) && state.table_id === tableId && stages.has(state.stage), 'STATE');
  protocol(Number.isSafeInteger(state.hand_number) && state.hand_number >= 0, 'HAND');
  protocol(
    Array.isArray(state.players) &&
      state.players.length === 2 &&
      new Set(state.players.map((player) => player.user_id)).size === 2 &&
      state.players.every((player) => record(player) && actorIds.has(player.user_id)),
    'ROSTER'
  );
  protocol(state.current_player === null || actorIds.has(state.current_player), 'CURRENT_PLAYER');
  if (state.current_player !== null && bettingStages.has(state.stage)) {
    protocol(
      typeof state.action_context === 'string' &&
        state.action_context.length > 0 &&
        state.action_context.length <= 200,
      'CONTEXT'
    );
    const player = state.players.find((player) => player.user_id === state.current_player);
    protocol(
      validMoney(state.current_bet) &&
        validMoney(player.bet) &&
        validMoney(player.stack) &&
        player.stack > 0 &&
        player.bet <= state.current_bet &&
        player.is_folded === false &&
        player.is_all_in === false,
      'DECISION_STATE'
    );
  }
  return state;
}

/**
 * Start exactly two real authenticated fixture clients. Call only once the
 * candidate engine is ready. No reconnects, state resyncs, seat mutation, SQL,
 * action fallback after rejection, or browser/suite success fabrication.
 * testEndpoints may point only to one explicit loopback port in boundary tests.
 */
export async function startFixtureActors({
  tableId,
  users,
  onFailure,
  testEndpoints,
  financialProof,
  signal,
}) {
  assert.match(tableId, uuid);
  assert.equal(typeof onFailure, 'function');
  if (signal !== undefined) {
    assert.ok(signal instanceof AbortSignal, 'FIXTURE_ACTOR_ABORT_SIGNAL');
    signal.throwIfAborted();
  }
  assert.ok(Array.isArray(users) && users.length === 2);
  const actorIds = new Set(users.map((user) => user.id));
  assert.equal(actorIds.size, 2);
  for (const user of users) {
    assert.match(user.id, uuid);
    const token = user.session?.access_token;
    protocol(
      typeof token === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token),
      'TOKEN'
    );
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    protocol(
      claims.sub === user.id &&
        claims.role === 'authenticated' &&
        Number.isSafeInteger(claims.exp) &&
        claims.exp > Math.floor(Date.now() / 1000) + 300,
      'TOKEN'
    );
    protocol(user.session.user?.id === user.id, 'SESSION');
  }
  const target = endpoints(testEndpoints);
  if (financialProof !== undefined) {
    protocol(
      record(financialProof) && Object.keys(financialProof).sort().join(',') === 'checkpoint,opId',
      'FINANCIAL_CONFIGURATION'
    );
    protocol(typeof financialProof.checkpoint === 'function', 'FINANCIAL_OBSERVER');
  }
  const actors = [];
  const financialRequests = new Set();
  const financial =
    financialProof === undefined
      ? null
      : financialRoutePhase({
          tableId,
          users,
          ...financialProof,
          async request(user, method, route, body) {
            protocol(!closed && users.includes(user), 'FINANCIAL_ACTOR');
            protocol(
              ['addchips', 'insurance', 'insurance-preview'].includes(route),
              'FINANCIAL_ROUTE'
            );
            const controller = new AbortController();
            financialRequests.add(controller);
            const timeout = setTimeout(() => controller.abort(), 3000);
            try {
              const url = new URL(`${target.http}/${route}`);
              if (method === 'GET') url.search = new URLSearchParams(body).toString();
              const response = await fetch(url, {
                method,
                redirect: 'error',
                signal: controller.signal,
                headers: {
                  authorization: `Bearer ${user.session.access_token}`,
                  'content-type': 'application/json',
                },
                ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
              });
              const text = await response.text();
              protocol(text.length <= 8192, 'FINANCIAL_RESPONSE');
              return { status: response.status, body: JSON.parse(text) };
            } finally {
              clearTimeout(timeout);
              financialRequests.delete(controller);
            }
          },
        });
  let closed = false,
    failed = false,
    enabled = false;
  let rejectReady, resolveReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function stop() {
    closed = true;
    signal?.removeEventListener('abort', aborted);
    clearTimeout(startupTimer);
    clearTimeout(lifetimeTimer);
    clearInterval(watchdog);
    for (const controller of financialRequests) controller.abort();
    for (const actor of actors) {
      clearTimeout(actor.timer);
      actor.controller?.abort();
      actor.socket.close();
    }
  }

  function aborted() {
    stop();
    rejectReady(new Error('FIXTURE_ACTOR_ABORTED'));
  }

  function fail(code) {
    if (closed || failed) return;
    failed = true;
    const error = new Error(/^FIXTURE_ACTOR_[A-Z_]+$/.test(code) ? code : 'FIXTURE_ACTOR_PROTOCOL');
    stop();
    rejectReady(error);
    onFailure(error);
  }

  function checkReady() {
    if (
      !enabled &&
      actors.length === 2 &&
      actors.every((actor) => actor.subscribed && actor.state)
    ) {
      enabled = true;
      clearTimeout(startupTimer);
      resolveReady();
      for (const actor of actors) schedule(actor);
    }
  }

  function schedule(actor) {
    if (closed || financial?.finished || !enabled || actor.inflight || actor.timer || !actor.state)
      return;
    const state = actor.state;
    if (!bettingStages.has(state.stage) || state.current_player !== actor.user.id) return;
    const context = state.action_context;
    if (actor.decisions.has(context)) return;
    // The HTTP ingress has a 250ms limiter per user/table. Pacing is before
    // the one attempt, and the decision is re-read after the delay.
    actor.timer = setTimeout(
      () => {
        actor.timer = null;
        if (closed) return;
        if (
          actor.state.action_context !== context ||
          actor.state.current_player !== actor.user.id
        ) {
          schedule(actor);
          return;
        }
        void act(actor, context).catch((error) => fail(error.message));
      },
      Math.max(350, actor.lastActionAt + 350 - Date.now())
    );
  }

  async function act(actor, context) {
    if (closed || actor.inflight || actor.decisions.has(context)) return;
    actor.inflight = true;
    if (financial) {
      await financial.beforeAction(actor.user, actor.state);
      protocol(
        !closed &&
          actor.state.action_context === context &&
          actor.state.current_player === actor.user.id,
        'FINANCIAL_CONTEXT_CHANGED'
      );
    }
    const state = actor.state,
      player = state.players.find((p) => p.user_id === actor.user.id);
    const toCall = state.current_bet - player.bet;
    const action = financial
      ? financial.action(state, player)
      : toCall === 0
        ? 'check'
        : toCall <= player.stack
          ? 'call'
          : 'fold';
    const idempotencyKey = randomUUID();
    actor.decisions.add(context);
    protocol(actor.decisions.size <= 1024, 'DECISION_LIMIT');
    actor.inflight = true;
    actor.lastActionAt = Date.now();
    actor.controller = new AbortController();
    const timeout = setTimeout(() => actor.controller.abort(), 10000);
    try {
      const response = await fetch(`${target.http}/action`, {
        method: 'POST',
        redirect: 'error',
        signal: actor.controller.signal,
        headers: {
          authorization: `Bearer ${actor.user.session.access_token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          tableId,
          action,
          idempotencyKey,
          actionContext: context,
        }),
      });
      protocol(response.status === 200, 'ACTION_HTTP');
      const body = await response.text();
      protocol(body.length <= 8192, 'ACTION_RESPONSE');
      const result = JSON.parse(body);
      protocol(
        record(result) && result.success === true && result.replayed !== true,
        'ACTION_REJECTED'
      );
    } catch (error) {
      if (!closed)
        throw new Error(
          error.message?.startsWith('FIXTURE_ACTOR_')
            ? error.message
            : 'FIXTURE_ACTOR_ACTION_TRANSPORT'
        );
    } finally {
      clearTimeout(timeout);
      actor.inflight = false;
      actor.controller = null;
    }
    schedule(actor);
  }

  function receive(actor, raw) {
    protocol(typeof raw === 'string' && raw.length <= 2 * 1024 * 1024, 'FRAME');
    const message = JSON.parse(raw);
    protocol(record(message) && typeof message.type === 'string', 'FRAME');
    actor.lastFrameAt = Date.now();
    if (message.type === 'PING') {
      protocol(Number.isFinite(message.ts), 'PING');
      actor.socket.send(JSON.stringify({ type: 'PONG', ts: message.ts }));
      return;
    }
    protocol(message.tableId === tableId, 'WRONG_TABLE');
    switch (message.type) {
      case 'SUBSCRIBED':
        protocol(!actor.subscribed, 'DUPLICATE_SUBSCRIPTION');
        actor.subscribed = true;
        break;
      case 'SNAPSHOT':
        protocol(
          Number.isSafeInteger(message.seq) &&
            message.seq >= 0 &&
            (actor.seq === null || message.seq >= actor.seq),
          'SEQUENCE'
        );
        if (message.seq === actor.seq) assert.deepEqual(message.state, actor.state);
        actor.state = stateShape(structuredClone(message.state), tableId, actorIds);
        actor.seq = message.seq;
        break;
      case 'DELTA':
        protocol(
          actor.state &&
            Number.isSafeInteger(message.seq) &&
            message.prev === actor.seq &&
            message.seq === actor.seq + 1,
          'SEQUENCE'
        );
        actor.state = stateShape(patched(actor.state, message.patch), tableId, actorIds);
        actor.seq = message.seq;
        break;
      case 'EVENT':
      case 'USER_EVENT':
        // Cards, clocks and animation events cannot replace authoritative state.
        protocol(record(message.payload) && typeof message.payload.type === 'string', 'EVENT');
        if (financial) void financial.event(message.payload).catch((error) => fail(error.message));
        return;
      case 'ERROR':
        throw new Error('FIXTURE_ACTOR_ENGINE_ERROR');
      default:
        throw new Error('FIXTURE_ACTOR_UNKNOWN_FRAME');
    }
    checkReady();
    schedule(actor);
  }

  const startupTimer = setTimeout(() => fail('FIXTURE_ACTOR_START_TIMEOUT'), 20000);
  const lifetimeTimer = setTimeout(() => fail('FIXTURE_ACTOR_LIFETIME_LIMIT'), 240000);
  const watchdog = setInterval(() => {
    if (actors.some((actor) => Date.now() - actor.lastFrameAt > 45000))
      fail('FIXTURE_ACTOR_SILENT_SOCKET');
  }, 1000);
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  try {
    signal?.throwIfAborted();
    for (const user of users) {
      const socket = new WebSocket(`${target.ws}/ws/multi?v=0`, [
        'bearer',
        user.session.access_token,
      ]);
      const actor = {
        user,
        socket,
        subscribed: false,
        state: null,
        seq: null,
        decisions: new Set(),
        inflight: false,
        timer: null,
        controller: null,
        lastActionAt: 0,
        lastFrameAt: Date.now(),
      };
      actors.push(actor);
      socket.addEventListener('open', () => {
        if (closed) return;
        if (socket.protocol !== 'bearer') return fail('FIXTURE_ACTOR_SUBPROTOCOL');
        socket.send(JSON.stringify({ type: 'SUBSCRIBE', tableId }));
      });
      socket.addEventListener('message', (event) => {
        if (closed) return;
        try {
          receive(actor, event.data);
        } catch (error) {
          fail(error.message);
        }
      });
      socket.addEventListener('error', () => fail('FIXTURE_ACTOR_SOCKET_ERROR'));
      socket.addEventListener('close', () => fail('FIXTURE_ACTOR_SOCKET_CLOSED'));
    }
    await ready;
    return Object.freeze({
      close: stop,
      ...(financial
        ? {
            financialObservations: () => financial.observations(),
            stateObservations: () =>
              actors.map((actor) => ({
                actor_id: actor.user.id,
                sequence: actor.seq,
                state: structuredClone(actor.state),
              })),
          }
        : {}),
    });
  } catch (error) {
    if (!closed) fail('FIXTURE_ACTOR_START_FAILED');
    throw error;
  }
}
