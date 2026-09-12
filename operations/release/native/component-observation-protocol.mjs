import assert from 'node:assert/strict';
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
  assert.ok(['catalogue', 'hand_presence', 'hand_facts', 'financial_facts'].includes(value?.read));
  keys(value, [
    'version',
    'request_id',
    'binding',
    'read',
    ...(value.read === 'catalogue'
      ? []
      : value.read === 'financial_facts'
        ? ['financial']
        : ['hand']),
  ]);
  assert.equal(value.version, 1);
  assert.match(value.request_id, uuid);
  sameBinding(value.binding, binding);
  if (value.read === 'financial_facts') validateFinancial(value.financial);
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
      keys(row, ['hand_number', 'pot_size', 'rake_amount', 'action_count', 'player_count']);
      assert.ok(Number.isSafeInteger(row.hand_number) && row.hand_number > 0);
      for (const key of ['pot_size', 'rake_amount'])
        assert.ok(
          typeof row[key] === 'string' &&
            row[key].length <= 80 &&
            /^-?[0-9]+(?:\.[0-9]+)?$/.test(row[key])
        );
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
      : request.read === 'financial_facts'
        ? ['financial']
        : ['hand']),
  ]);
  assert.equal(value.version, 1);
  assert.equal(value.request_id, request.request_id);
  sameBinding(value.binding, request.binding);
  assert.equal(value.read, request.read);
  if (request.read === 'financial_facts')
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
