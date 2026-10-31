import assert from 'node:assert/strict';
import {
  validateTournamentRead,
  validateTournamentPlayerData,
} from './tournament-player-observations.mjs';
export {
  tournamentObservationBinding,
  observeTournamentPlayerFacts,
} from './tournament-player-observations.mjs';
export const OBSERVATION_SOCKET = '/run/fixture-observer/observation.sock';
export const REQUEST_BYTES = 4096;
export const REPLY_BYTES = 65536;
export const PERSISTENCE_MS = 15000;
export const READ_MS = 6000;
export const FINANCIAL_MS = 120000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function keys(value, expected) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}
export function validateBinding(value) {
  keys(value, ['version', 'instance_id', 'control_sha', 'table_id', 'spectator_user_id']);
  assert.equal(value.version, 1);
  for (const key of ['instance_id', 'table_id', 'spectator_user_id'])
    assert.match(value[key], uuid);
  assert.match(value.control_sha, /^[0-9a-f]{40}$/);
  return Object.freeze({ ...value });
}
export function sameBinding(actual, expected) {
  validateBinding(actual);
  for (const key of Object.keys(expected)) assert.equal(actual[key], expected[key]);
}
export function validateHand(hand) {
  keys(hand, ['hand_number', 'next_hand_number']);
  assert.ok(Number.isSafeInteger(hand.hand_number) && hand.hand_number > 0);
  assert.ok(
    Number.isSafeInteger(hand.next_hand_number) && hand.next_hand_number > hand.hand_number
  );
  return Object.freeze({ ...hand });
}
export function validateRequest(value, binding) {
  assert.ok(
    [
      'catalogue',
      'hand_presence',
      'hand_facts',
      'financial_facts',
      'tournament_player_facts',
    ].includes(value?.read)
  );
  keys(value, [
    'version',
    'request_id',
    'binding',
    'read',
    ...(value.read === 'catalogue'
      ? []
      : value.read === 'tournament_player_facts'
        ? ['tournament']
        : value.read === 'financial_facts'
          ? ['financial']
          : ['hand']),
  ]);
  assert.equal(value.version, 1);
  assert.match(value.request_id, uuid);
  sameBinding(value.binding, binding);
  if (value.read === 'tournament_player_facts') validateTournamentRead(value.tournament);
  else if (value.read === 'financial_facts') validateFinancial(value.financial);
  else if (value.read !== 'catalogue') validateHand(value.hand);
  return value;
}
export function validateFinancial(value) {
  keys(value, ['actor_index', 'op_id', 'hand_number']);
  assert.ok(value.actor_index === 0 || value.actor_index === 1);
  assert.match(value.op_id, /^[A-Za-z0-9-]{8,64}$/);
  assert.ok(Number.isSafeInteger(value.hand_number) && value.hand_number > 0);
  return Object.freeze({ ...value });
}
// Exact tuple widths and caps. SQL produces only selected facts, not arbitrary
// JSON objects or a fixture-authored success/certificate flag.
export const FINANCIAL_SECTIONS = Object.freeze({
  scope: [1, 6],
  banks: [2, 4],
  hands: [2, 5],
  wallets: [2, 2],
  seats: [8, 4],
  addons: [8, 7],
  addon_keys: [2, 5],
  receipts: [2, 6],
  ledger: [64, 8],
  wallet_transactions: [64, 6],
  insurance: [8, 9],
  offers: [24, 7],
  commits: [2, 6],
});
export function validateFinancialData(data) {
  keys(data, ['actor_ids', ...Object.keys(FINANCIAL_SECTIONS)]);
  assert.ok(Array.isArray(data.actor_ids) && data.actor_ids.length === 2);
  data.actor_ids.forEach((id) => assert.match(id, uuid));
  assert.notEqual(data.actor_ids[0], data.actor_ids[1]);
  for (const [name, [cap, width]] of Object.entries(FINANCIAL_SECTIONS)) {
    assert.ok(
      Array.isArray(data[name]) && data[name].length <= cap,
      'FINANCIAL_OBSERVATION_ROW_CAP'
    );
    for (const row of data[name]) {
      assert.ok(Array.isArray(row) && row.length === width, 'FINANCIAL_OBSERVATION_TUPLE');
      for (const item of row)
        assert.ok(
          item === null || (typeof item === 'string' && item.length <= 8192),
          'FINANCIAL_OBSERVATION_VALUE'
        );
    }
  }
  return data;
}
export function validateData(read, data) {
  if (read === 'tournament_player_facts') return validateTournamentPlayerData(data);
  if (read === 'financial_facts') return validateFinancialData(data);
  if (read === 'catalogue') {
    keys(data, ['catalogue_digest']);
    assert.match(data.catalogue_digest, /^[0-9a-f]{64}$/);
  } else if (read === 'hand_presence') {
    keys(data, ['count']);
    assert.ok(Number.isSafeInteger(data.count) && data.count >= 0);
  } else {
    keys(data, ['count', 'rows', 'seat_count']);
    assert.ok(Number.isSafeInteger(data.count) && data.count >= 0);
    assert.ok(Number.isSafeInteger(data.seat_count) && data.seat_count >= 0);
    assert.ok(Array.isArray(data.rows) && data.rows.length <= 2);
    for (const row of data.rows) {
      keys(row, [
        'hand_number',
        'pot_size',
        'rake_amount',
        'action_count',
        'player_count',
        'public_actions',
      ]);
      assert.ok(Number.isSafeInteger(row.hand_number) && row.hand_number > 0);
      for (const key of ['pot_size', 'rake_amount'])
        assert.ok(
          typeof row[key] === 'string' &&
            row[key].length <= 80 &&
            /^-?[0-9]+(?:\.[0-9]+)?$/.test(row[key])
        );
      assert.ok(Array.isArray(row.public_actions) && row.public_actions.length <= 128);
      for (const a of row.public_actions) {
        keys(a, ['ordinal', 'user_id', 'seat', 'action', 'amount', 'street', 'origin']);
        assert.ok(Number.isSafeInteger(a.ordinal) && a.ordinal > 0);
        assert.match(a.user_id, uuid);
        assert.ok(Number.isSafeInteger(a.seat) && a.seat >= 1 && a.seat <= 10);
        assert.ok(['raise', 'call', 'all_in', 'fold'].includes(a.action));
        assert.ok(Number.isFinite(a.amount) && a.amount >= 0);
        assert.ok(['preflop', 'flop', 'turn', 'river'].includes(a.street));
        assert.ok(
          a.origin === null ||
            [
              'player',
              'pre_action',
              'horse_policy',
              'horse_fallback',
              'forced',
              'unknown',
            ].includes(a.origin)
        );
      }
      for (const key of ['action_count', 'player_count'])
        assert.ok(row[key] === null || (Number.isSafeInteger(row[key]) && row[key] >= 0));
    }
  }
  return data;
}
export function validateResponse(value, request) {
  keys(value, [
    'version',
    'request_id',
    'binding',
    'read',
    'data',
    ...(request.read === 'catalogue'
      ? []
      : request.read === 'tournament_player_facts'
        ? ['tournament']
        : request.read === 'financial_facts'
          ? ['financial']
          : ['hand']),
  ]);
  assert.equal(value.version, 1);
  assert.equal(value.request_id, request.request_id);
  sameBinding(value.binding, request.binding);
  assert.equal(value.read, request.read);
  if (request.read === 'tournament_player_facts')
    assert.deepEqual(validateTournamentRead(value.tournament), request.tournament);
  else if (request.read === 'financial_facts')
    assert.deepEqual(validateFinancial(value.financial), request.financial);
  else if (request.read !== 'catalogue') assert.deepEqual(validateHand(value.hand), request.hand);
  return validateData(value.read, value.data);
}
export function verifyObservedHandFacts(facts, hand) {
  validateHand(hand);
  validateData('hand_facts', facts);
  assert.equal(facts.count, 1, 'the browser-observed hand must persist once');
  assert.equal(facts.rows.length, 1);
  const row = facts.rows[0];
  assert.equal(row.hand_number, hand.hand_number);
  assert.ok(row.action_count > 0 && row.player_count >= 2);
  assert.ok(Number.isFinite(Number(row.pot_size)) && Number(row.pot_size) > 0);
  assert.ok(Number(row.rake_amount) >= 0 && Number(row.rake_amount) <= Number(row.pot_size));
  assert.equal(facts.seat_count, 0, 'spectator acquired a seat');
  return {
    hand_number: hand.hand_number,
    next_hand_number: hand.next_hand_number,
    actions: row.action_count,
    players: row.player_count,
    seat_count: facts.seat_count,
  };
}

/** Same owned hand, actual browser requests and public engine events, then the
 * saved producer's exact raise-TO/all-in-TO amounts. No card or guessed result. */
export function verifyBrowserActionHistory({ tableId, hand, facts, actions, events }) {
  verifyObservedHandFacts(facts, hand);
  assert.equal(actions.length, 4);
  const stored = facts.rows[0].public_actions;
  assert.equal(stored.length, 4, 'BROWSER_ACTION_HISTORY_EXTRA_OR_MISSING');
  let priorEventIndex = -1;
  const types = ['raise', 'call', 'all_in', 'fold'];
  assert.match(tableId, uuid);
  const keysSeen = new Set(),
    contextsSeen = new Set();
  for (let i = 0; i < 4; i++) {
    const a = actions[i],
      row = stored[i];
    assert.equal(a.table_id, tableId);
    assert.equal(a.action, types[i]);
    assert.equal(a.hand_number, hand.hand_number);
    assert.equal(a.status, 200);
    assert.equal(a.success, true);
    assert.equal(a.requests, 1, 'BROWSER_ACTION_REPLAY_OR_DUPLICATE');
    assert.ok(typeof a.idempotency_key === 'string' && a.idempotency_key.length > 0);
    assert.ok(!keysSeen.has(a.idempotency_key));
    keysSeen.add(a.idempotency_key);
    assert.ok(typeof a.action_context === 'string' && a.action_context.length > 0);
    assert.ok(!contextsSeen.has(a.action_context));
    contextsSeen.add(a.action_context);
    assert.equal(row.user_id, a.user_id);
    assert.equal(row.seat, a.seat);
    assert.equal(row.action, a.action);
    assert.equal(row.origin, 'player');
    assert.equal(row.street, i < 2 ? 'preflop' : 'flop');
    assert.equal(row.street, a.street);
    assert.equal(row.amount, a.amount);
    if (i) assert.ok(row.ordinal > stored[i - 1].ordinal);
    assert.ok(Number.isFinite(a.before_stack) && a.before_stack > 0);
    assert.ok(Number.isFinite(a.before_bet) && a.before_bet >= 0);
    assert.ok(Number.isFinite(a.before_current_bet) && a.before_current_bet >= 0);
    if (a.action === 'raise')
      assert.ok(a.amount > a.before_current_bet && a.amount < a.before_stack + a.before_bet);
    if (a.action === 'call') {
      assert.equal(a.amount, a.before_current_bet - a.before_bet);
      assert.ok(a.amount > 0 && a.amount < a.before_stack);
    }
    if (a.action === 'all_in') {
      assert.equal(a.amount, a.before_stack + a.before_bet);
      assert.ok(a.amount > a.before_current_bet);
    }
    if (a.action === 'fold') {
      assert.equal(a.amount, 0);
      assert.ok(a.before_current_bet > a.before_bet);
    }
    const matched = events.filter(
      (e) =>
        e.type === 'player_action' &&
        e.hand_number === a.hand_number &&
        e.user_id === a.user_id &&
        e.action === a.action
    );
    assert.equal(matched.length, 1, 'BROWSER_ACTION_EVENT_EXTRA_OR_MISSING');
    const event = matched[0];
    const eventIndex = events.indexOf(event);
    assert.ok(eventIndex > priorEventIndex);
    priorEventIndex = eventIndex;
    assert.equal(event.table_id, tableId);
    assert.notEqual(event.replayed, true);
    assert.equal(event.seat, a.seat);
    assert.equal(event.stage, a.street);
    assert.equal(event.amount, a.amount);
  }
  assert.equal(actions[0].user_id, actions[3].user_id);
  assert.equal(actions[1].user_id, actions[2].user_id);
  assert.notEqual(actions[0].user_id, actions[1].user_id);
  return {
    table_id: tableId,
    hand_number: hand.hand_number,
    accepted_http_count: actions.filter(
      (a) => a.status === 200 && a.success === true && a.requests === 1
    ).length,
    wire_event_count: actions.reduce(
      (n, a) =>
        n +
        events.filter(
          (e) =>
            e.type === 'player_action' &&
            e.hand_number === a.hand_number &&
            e.user_id === a.user_id &&
            e.action === a.action
        ).length,
      0
    ),
    history_count: facts.count,
    actions: stored.map((a) => ({ ...a })),
  };
}
