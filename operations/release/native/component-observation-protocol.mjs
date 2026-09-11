import assert from 'node:assert/strict';
export const OBSERVATION_SOCKET = '/run/fixture-observer/observation.sock';
export const REQUEST_BYTES = 4096;
export const REPLY_BYTES = 65536;
export const PERSISTENCE_MS = 15000;
export const READ_MS = 6000;
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
  assert.ok(['catalogue', 'hand_presence', 'hand_facts'].includes(value?.read));
  keys(value, [
    'version',
    'request_id',
    'binding',
    'read',
    ...(value.read === 'catalogue' ? [] : ['hand']),
  ]);
  assert.equal(value.version, 1);
  assert.match(value.request_id, uuid);
  sameBinding(value.binding, binding);
  if (value.read !== 'catalogue') validateHand(value.hand);
  return value;
}
export function validateData(read, data) {
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
    ...(request.read === 'catalogue' ? [] : ['hand']),
  ]);
  assert.equal(value.version, 1);
  assert.equal(value.request_id, request.request_id);
  sameBinding(value.binding, request.binding);
  assert.equal(value.read, request.read);
  if (request.read !== 'catalogue') assert.deepEqual(validateHand(value.hand), request.hand);
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
