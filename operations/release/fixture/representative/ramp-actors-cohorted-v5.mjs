import assert from 'node:assert/strict';
import {observeArrivalClock} from './arrival-clock.mjs';
import { randomUUID } from 'node:crypto';
import { financialRoutePhase } from '../financial-route-phase.mjs';

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

function stateShape(state, tableId, actorIds, previous, event, previousSequence, nonactingArrival=false) {
  protocol(record(state) && state.table_id === tableId && stages.has(state.stage), 'STATE');
  protocol(Number.isSafeInteger(state.hand_number) && state.hand_number >= 0, 'HAND');
  protocol(
    Array.isArray(state.players) &&
      state.players.length >= 2 && state.players.length <= 9 &&
      new Set(state.players.map((player) => player.user_id)).size === state.players.length &&
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
    protocol(
      Number.isSafeInteger(state.turn_start_time_ms) && state.turn_start_time_ms > 0,
      'TURN_CLOCK'
    );
    const player = state.players.find((player) => player.user_id === state.current_player);
    protocol(
      validMoney(state.current_bet) &&
        validMoney(player.bet) &&
        validMoney(player.stack) &&
        player.bet <= state.current_bet &&
        typeof player.is_folded === 'boolean' &&
        typeof player.is_all_in === 'boolean',
      'DECISION_STATE'
    );
    if ((player.stack === 0 || player.is_folded || player.is_all_in) && !nonactingArrival) {
      const old = previous?.players.find((p) => p.user_id === state.current_player);
      protocol(
        old &&
          previous.current_player === state.current_player &&
          previous.hand_number === state.hand_number &&
          (previous.turn_start_time_ms === state.turn_start_time_ms ||
            (event?.stateSequence === previousSequence &&
              Number.isSafeInteger(event.timestamp) &&
              state.turn_start_time_ms >= previous.turn_start_time_ms &&
              state.turn_start_time_ms <= event.timestamp)) &&
          Number.isSafeInteger(event?.wireSequence) &&
          Number.isSafeInteger(event?.stateSequence) &&
          event.stateSequence <= previousSequence &&
          (old.is_all_in || old.is_folded || event.stateSequence === previousSequence) &&
          event?.type === 'player_action' &&
          event.hand_number === state.hand_number &&
          event.user_id === player.user_id &&
          event.replayed !== true &&
          ((event.action === 'all_in' &&
            player.stack === 0 &&
            player.is_all_in &&
            !player.is_folded &&
            !old.is_folded &&
            (old.stack > 0 || old.is_all_in)) ||
            (event.action === 'fold' &&
              player.is_folded &&
              !player.is_all_in &&
              player.stack === old.stack)),
        'DECISION_STATE'
      );
    }
  }
  return state;
}

/**
 * Maintained isolated representative input: start 2..9 real authenticated clients.
 * Reviewed protocol base cc3031da5198a95351fae090aad5f85b6e673371.
 * This is a finite component input fixture, never a product certificate. Call only once the
 * candidate engine is ready. Explicit finite playing-actor reconnect preserves
 * spent decision/turn identities and in-flight HTTP requests. No seat mutation, SQL,
 * action fallback after rejection, or browser/suite success fabrication.
 * testEndpoints may point only to one explicit loopback port in boundary tests.
 */
export async function startRampActors({
  tableId,
  users,
  onFailure,
  testEndpoints,
  financialProof,
  checkpoint,
  startPaused=false,
  setupFold=false,
  observeArrival=setupFold,
  signal,
}) {
  assert.match(tableId, uuid);
  assert.equal(typeof onFailure, 'function');
  assert.equal(typeof checkpoint, 'function');
  assert.equal(typeof setupFold,'boolean');
  assert.equal(financialProof, undefined, 'Ramp qualification does not combine the separate financial actor phase');
  const observations={actions:0,httpFailures:0,snapshots:0,deltas:0,reconnects:[],latencies:[],hands:new Set()};
  if (signal !== undefined) {
    assert.ok(signal instanceof AbortSignal, 'FIXTURE_ACTOR_ABORT_SIGNAL');
    signal.throwIfAborted();
  }
  assert.ok(Array.isArray(users) && users.length >= 2 && users.length <= 9);
  const actorIds = new Set(users.map((user) => user.id));
  assert.equal(actorIds.size, users.length);
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
  const actionTasks=new Set();
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
  const actorStartedAt=Date.now();let measurementStartedAt=null;let phaseStartTurns=new Map();
  let paused=startPaused;
  let closed = false,
    closing = false,
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
      clearTimeout(actor.reconnectTimer);
      actor.rejectReconnect?.(new Error('RAMP_STOPPED'));
      actor.controller?.abort();
      actor.socket.close();
    }
  }

  function aborted() {
    stop();
    rejectReady(new Error('FIXTURE_ACTOR_ABORTED'));
  }

  function fail(code) {
    if (failed) return;
    failed = true;
    const error = new Error(/^FIXTURE_ACTOR_[A-Z_]+$/.test(code) ? code : 'FIXTURE_ACTOR_PROTOCOL');
    stop();
    rejectReady(error);
    onFailure(error);
  }

  function checkReady() {
    if (
      !enabled &&
      actors.length === users.length &&
      actors.every((actor) => actor.subscribed && actor.state)
    ) {
      enabled = true;
      clearTimeout(startupTimer);
      resolveReady();
      for (const actor of actors) schedule(actor);
    }
  }

  const turnKey = (state) => `${state.hand_number}:${state.turn_start_time_ms}`;

  function schedule(actor) {
    if (closed || paused || (observeArrival && !actor.arrivalReady) || financial?.finished || !enabled || actor.inflight || actor.timer || !actor.state)
      return;
    const state = actor.state;
    if (!bettingStages.has(state.stage) || state.current_player !== actor.user.id) return;
    const player = state.players.find((p) => p.user_id === actor.user.id);
    if (player.stack <= 0 || player.is_folded || player.is_all_in) return;
    const context = state.action_context;
    const turn = turnKey(state);
    if (actor.decisions.has(context) || actor.turns.has(turn)) return;
    // The HTTP ingress has a 250ms limiter per user/table. Pacing is before
    // the one attempt, and the decision is re-read after the delay.
    actor.timer = setTimeout(
      () => {
        actor.timer = null;
        if (closed) return;
        if (
          !actor.state ||
          turnKey(actor.state) !== turn ||
          actor.state.action_context !== context ||
          actor.state.current_player !== actor.user.id
        ) {
          schedule(actor);
          return;
        }
        const task=act(actor,context,turn).catch(error=>fail(error.message)).finally(()=>actionTasks.delete(task));actionTasks.add(task);
      },
      Math.max(350, actor.lastActionAt + 350 - Date.now())
    );
  }

  async function act(actor, context, turn) {
    if (closed || actor.inflight || actor.decisions.has(context) || actor.turns.has(turn)) return;
    actor.inflight = true;
    if (financial) {
      await financial.beforeAction(actor.user, actor.state);
      protocol(
        !closed &&
          turnKey(actor.state) === turn &&
          actor.state.action_context === context &&
          actor.state.current_player === actor.user.id,
        'FINANCIAL_CONTEXT_CHANGED'
      );
    }
    const state = actor.state,
      player = state.players.find((p) => p.user_id === actor.user.id);
    const toCall = state.current_bet - player.bet;
    const action = setupFold ? 'fold' : financial
      ? financial.action(state, player)
      : toCall === 0
        ? 'check'
        : toCall <= player.stack
          ? 'call'
          : 'fold';
    const idempotencyKey = randomUUID();
    actor.decisions.add(context);
    // A post-action publication changes context before the next turn is armed.
    // Keep the answered clock spent until authoritative state names a new turn.
    actor.turns.add(turn);
    protocol(actor.decisions.size <= 1024, 'DECISION_LIMIT');
    actor.inflight = true;
    const operation={actorId:actor.user.id,tableId,handNumber:state.hand_number,turn,context,action,idempotencyKey,outcome:'unknown',started:new Date().toISOString()};
    await checkpoint(operation);
    protocol(!closed && actor.state && turnKey(actor.state)===turn && actor.state.action_context===context && actor.state.current_player===actor.user.id,'JOURNAL_CONTEXT_CHANGED');
    actor.lastActionAt = Date.now();
    const actionStart=performance.now();
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
      operation.httpStatus=response.status;
      if(response.status!==200)observations.httpFailures++;

      const body = await response.text();
      protocol(body.length <= 8192, 'ACTION_RESPONSE');
      const result = JSON.parse(body);
      operation.result=result;operation.outcome='returned';operation.latencyMs=performance.now()-actionStart;await checkpoint(operation);
      protocol(response.status === 200, 'ACTION_HTTP');
      protocol(
        record(result) && result.success === true && result.replayed !== true,
        'ACTION_REJECTED'
      );
      observations.actions++;observations.latencies.push(operation.latencyMs);
    } catch (error) {
      operation.error=error.message;await checkpoint(operation);
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
        const arrival=observeArrival&&!actor.arrivalReady?observeArrivalClock(actor,message.state):false;
        actor.state = stateShape(structuredClone(message.state), tableId, actorIds,undefined,undefined,undefined,arrival);
        actor.seq = message.seq;
        observations.snapshots++;observations.hands.add(actor.state.hand_number);
        if(actor.resolveReconnect){const resolve=actor.resolveReconnect;actor.resolveReconnect=null;actor.rejectReconnect=null;clearTimeout(actor.reconnectTimer);resolve({actorId:actor.user.id,sequence:actor.seq,handNumber:actor.state.hand_number,spentTurns:actor.turns.size,spentContexts:actor.decisions.size});}
        break;
      case 'DELTA':
        protocol(
          actor.state &&
            Number.isSafeInteger(message.seq) &&
            message.prev === actor.seq &&
            message.seq === actor.seq + 1,
          'SEQUENCE'
        );
        const next=patched(actor.state,message.patch);
        const deltaArrival=observeArrival&&!actor.arrivalReady?observeArrivalClock(actor,next):false;
        actor.state = stateShape(next, tableId, actorIds, actor.state, actor.lastPublicEvent, actor.seq,deltaArrival);
        actor.seq = message.seq;
        observations.deltas++;observations.hands.add(actor.state.hand_number);
        break;
      case 'USER_EVENT':
        // TableStateHub private envelopes use kind, not the public event type.
        // They cannot drive authoritative decisions or the financial proof route.
        protocol(
          record(message.payload) &&
            ['hole_cards', 'pre_action', 'add_on_adjusted'].includes(message.payload.kind),
          'USER_EVENT'
        );
        return;
      case 'EVENT':
        // Cards, clocks and animation events cannot replace authoritative state.
        protocol(record(message.payload) && typeof message.payload.type === 'string', 'EVENT');
        if (message.payload.type === 'player_action') {
          protocol(
            Number.isSafeInteger(message.seq) &&
              message.seq >= 0 &&
              Number.isSafeInteger(message.payload.hand_number) &&
              actorIds.has(message.payload.user_id),
            'EVENT'
          );
        }
        actor.lastPublicEvent = {
          ...message.payload,
          wireSequence: message.seq,
          stateSequence: actor.seq,
        };
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

  function connect(actor) {
    const generation=++actor.generation;const previous=actor.socket;
    clearTimeout(actor.timer);actor.timer=null;
    actor.state=null;actor.seq=null;actor.subscribed=false;actor.lastFrameAt=Date.now();
    previous?.close();
    const socket=actor.socket=new WebSocket(`${target.ws}/ws/multi?v=0`,['bearer',actor.user.session.access_token]);
    socket.addEventListener('open',()=>{if(closed||actor.generation!==generation)return;if(socket.protocol!=='bearer')return fail('FIXTURE_ACTOR_SUBPROTOCOL');socket.send(JSON.stringify({type:'SUBSCRIBE',tableId}));});
    socket.addEventListener('message',event=>{if(closed||closing||actor.generation!==generation)return;try{receive(actor,event.data);}catch(error){paused=true;for(const other of actors){clearTimeout(other.timer);other.timer=null;}const evidence={kind:'protocol-refusal',actorId:actor.user.id,tableId,at:new Date().toISOString(),error:error.message,rawFrame:typeof event.data==='string'?event.data.slice(0,2*1024*1024):null,previousSequence:actor.seq,previousState:actor.state,lastPublicEvent:actor.lastPublicEvent};const logging=Promise.resolve().then(()=>checkpoint(evidence));actionTasks.add(logging);logging.then(()=>{actionTasks.delete(logging);fail(error.message);},()=>{actionTasks.delete(logging);fail('FIXTURE_ACTOR_CHECKPOINT');});}});
    socket.addEventListener('error',()=>{if(!closed&&!closing&&actor.generation===generation)fail('FIXTURE_ACTOR_SOCKET_ERROR');});
    socket.addEventListener('close',()=>{if(!closed&&!closing&&actor.generation===generation)fail('FIXTURE_ACTOR_SOCKET_CLOSED');});
  }
  async function reconnect(actorId) {
    protocol(!closed&&enabled,'RECONNECT_NOT_READY');
    const actor=actors.find(a=>a.user.id===actorId);protocol(actor&&!actor.resolveReconnect,'RECONNECT_ACTOR');
    const claim=JSON.parse(Buffer.from(actor.user.session.access_token.split('.')[1],'base64url'));
    protocol(claim.sub===actorId&&claim.exp>Date.now()/1000+60,'RECONNECT_TOKEN');
    const receipt={kind:'playing-actor-reconnect',actorId,tableId,started:new Date().toISOString(),inflight:actor.inflight,spentTurns:actor.turns.size,spentContexts:actor.decisions.size,outcome:'unknown'};
    await checkpoint(receipt);observations.reconnects.push(receipt);
    const readyAgain=new Promise((resolve,reject)=>{actor.resolveReconnect=resolve;actor.rejectReconnect=reject;actor.reconnectTimer=setTimeout(()=>{reject(new Error('FIXTURE_ACTOR_RECONNECT_TIMEOUT'));fail('FIXTURE_ACTOR_RECONNECT_TIMEOUT');},20000);});
    connect(actor); // HTTP controller and original request identity deliberately survive.
    const snapshot=await readyAgain;Object.assign(receipt,{outcome:'snapshot',finished:new Date().toISOString(),snapshot});await checkpoint(receipt);return receipt;
  }

  const startupTimer = setTimeout(() => fail('FIXTURE_ACTOR_START_TIMEOUT'), 20000);
  let lifetimeTimer=startPaused?null:setTimeout(() => fail('FIXTURE_ACTOR_LIFETIME_LIMIT'),240000);
  const watchdog = setInterval(() => {
    if (actors.some((actor) => Date.now() - actor.lastFrameAt > 45000))
      fail('FIXTURE_ACTOR_SILENT_SOCKET');
  }, 1000);
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  try {
    signal?.throwIfAborted();
    for (const user of users) {
      const actor = {
        user,
        socket:null,
        generation:0,
        subscribed: false,
        state: null,
        seq: null,
        decisions: new Set(),
        turns: new Set(),
        inflight: false,
        timer: null,
        controller: null,
        lastActionAt: 0,
        lastFrameAt: Date.now(),
      };
      actors.push(actor);
      connect(actor);
    }
    await ready;
    return Object.freeze({
      close: async()=>{closing=true;paused=true;for(const actor of actors){clearTimeout(actor.timer);actor.timer=null;}await Promise.allSettled([...actionTasks]);stop();},
      activate:()=>{protocol(!closed&&enabled&&paused&&!lifetimeTimer,'ACTIVATION');paused=false;lifetimeTimer=setTimeout(()=>fail('FIXTURE_ACTOR_LIFETIME_LIMIT'),240000);for(const actor of actors)schedule(actor);},
      beginMeasurement:({durationMs=180000}={})=>{protocol(!closed&&enabled&&paused&&setupFold&&!startPaused,'MEASUREMENT_HANDOFF');protocol(Number.isSafeInteger(durationMs)&&durationMs>0&&durationMs<=180000&&actorStartedAt+240000-Date.now()>=durationMs+10000,'MEASUREMENT_LIFETIME');protocol(actionTasks.size===0,'MEASUREMENT_PENDING_ACTION');setupFold=false;measurementStartedAt=new Date().toISOString();phaseStartTurns=new Map(actors.map(a=>[a.user.id,a.turns.size]));observations.setupActions=observations.actions;observations.actions=0;observations.latencies=[];paused=false;for(const actor of actors)schedule(actor);return {actorStartedAt:new Date(actorStartedAt).toISOString(),measurementStartedAt,remainingLifetimeMs:actorStartedAt+240000-Date.now(),generationRetained:true};},
      pendingActions:()=>actionTasks.size,
      quiesce:()=>{paused=true;for(const actor of actors){clearTimeout(actor.timer);actor.timer=null;}},
      reconnect,
      observations:()=>({...observations,hands:[...observations.hands],actors:actors.map(a=>({actorId:a.user.id,inflight:a.inflight,spentTurns:a.turns.size-(phaseStartTurns.get(a.user.id)??0),totalSpentTurns:a.turns.size,spentContexts:a.decisions.size,connected:!closed&&!!a.state&&a.socket.readyState===1,alive:!closed&&!!a.state?.players.some(p=>p.user_id===a.user.id&&p.stack>0&&!p.is_sitting_out&&!p.is_disconnected)}))}),
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
