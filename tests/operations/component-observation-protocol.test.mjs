import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  validateRequest,
  validateResponse,
  verifyObservedHandFacts,
} from '../../operations/release/native/component-observation-protocol.mjs';
const binding = {
  version: 1,
  instance_id: randomUUID(),
  control_sha: 'a'.repeat(40),
  table_id: randomUUID(),
  spectator_user_id: randomUUID(),
};
const hand = { hand_number: 17, next_hand_number: 18 };
const request = { version: 1, request_id: randomUUID(), binding, read: 'hand_facts', hand };
const data = {
  count: 1,
  rows: [
    { hand_number: 17, pot_size: '25.00', rake_amount: '1.00', action_count: 2, player_count: 2 },
  ],
  seat_count: 0,
};
test('fixed request refuses SQL, identifiers, substituted binding and invalid tuple', () => {
  validateRequest(request, binding);
  for (const value of [
    { ...request, sql: 'SELECT 1' },
    { ...request, read: 'query' },
    { ...request, binding: { ...binding, table_id: randomUUID() } },
    { ...request, hand: { hand_number: 17, next_hand_number: 17 } },
    { ...request, hand: { ...hand, path: '/etc/passwd' } },
  ])
    assert.throws(() => validateRequest(value, binding));
});
test('response forbids pass flags and binds exact request/instance', () => {
  const response = { ...request, data };
  assert.deepEqual(validateResponse(response, request), data);
  for (const value of [
    { ...response, success: true },
    { ...response, request_id: randomUUID() },
    { ...response, binding: { ...binding, instance_id: randomUUID() } },
    { ...response, data: { ...data, sql: 'SELECT 1' } },
  ])
    assert.throws(() => validateResponse(value, request));
});
test('oracle derives result from facts and refuses duplicate/empty hand and seated spectator', () => {
  assert.equal(verifyObservedHandFacts(data, hand).actions, 2);
  for (const value of [
    { ...data, count: 2 },
    { ...data, seat_count: 1 },
    { ...data, rows: [] },
    { ...data, rows: [{ ...data.rows[0], action_count: 0 }] },
    { ...data, rows: [{ ...data.rows[0], rake_amount: '100.00' }] },
  ])
    assert.throws(() => verifyObservedHandFacts(value, hand));
});
