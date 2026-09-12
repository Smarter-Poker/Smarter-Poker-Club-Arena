import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  validateRequest,
  validateResponse,
  verifyObservedHandFacts,
  FINANCIAL_SECTIONS,
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
test('financial facts bind one actor slot, operation and hand without exposing SQL selectors', () => {
  const financial = { actor_index: 0, op_id: 'owned-operation-0001', hand_number: 17 };
  const req = { version: 1, request_id: randomUUID(), binding, read: 'financial_facts', financial };
  const facts = {
    actor_ids: [randomUUID(), randomUUID()],
    ...Object.fromEntries(Object.keys(FINANCIAL_SECTIONS).map((k) => [k, []])),
  };
  validateRequest(req, binding);
  assert.deepEqual(validateResponse({ ...req, data: facts }, req), facts);
  for (const invalid of [
    { ...financial, actor_index: 2 },
    { ...financial, op_id: 'x;SELECT 1' },
    { ...financial, hand_number: 0 },
    { ...financial, actor_id: randomUUID() },
  ]) {
    assert.throws(() => validateRequest({ ...req, financial: invalid }, binding));
  }
  assert.throws(() =>
    validateResponse(
      { ...req, financial: { ...financial, op_id: 'changed-operation' }, data: facts },
      req
    )
  );
  assert.throws(() => validateResponse({ ...req, data: { ...facts, passed: true } }, req));
  assert.throws(() =>
    validateResponse(
      { ...req, data: { ...facts, ledger: Array(65).fill(Array(8).fill('x')) } },
      req
    )
  );
  assert.throws(() =>
    validateResponse({ ...req, data: { ...facts, wallets: [{ success: true }] } }, req)
  );
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
