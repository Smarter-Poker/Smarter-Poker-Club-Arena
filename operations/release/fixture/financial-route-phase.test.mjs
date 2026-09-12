// Protocol fixtures only: these tests never certify a funded engine hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { financialRoutePhase } from './financial-route-phase.mjs';
const tableId = '11111111-1111-4111-8111-111111111111';
const users = [
  { id: '22222222-2222-4222-8222-222222222222' },
  { id: '33333333-3333-4333-8333-333333333333' },
];
const state = { stage: 'preflop', hand_number: 1000001, current_bet: 2 };
const offer = () => ({
  type: 'insurance_offers',
  table_id: tableId,
  hand_number: state.hand_number,
  street: 'turn',
  board: ['2s', '3h', '4d', '8c'],
  deadlineAt: Date.now() + 20000,
  pot: 400,
  offers: [{ playerId: users[1].id, fullPremium: 12, fullInsuredAmount: 200 }],
});
function fixture(change = () => {}) {
  const requests = [],
    marks = [];
  let previews = 0;
  const phase = financialRoutePhase({
    tableId,
    users,
    opId: 'real-client-attempt-0001',
    checkpoint: async (x) => marks.push(x),
    async request(user, method, route, body) {
      requests.push({ actor: user.id, method, route, body: structuredClone(body) });
      const refused = body.opId === '' || body.coveragePercent === '100';
      let result = {
        status: refused ? 400 : 200,
        body: refused
          ? { success: false, error: 'invalid input' }
          : route === 'addchips'
            ? { success: true, queued: true, applied: 10 }
            : route === 'insurance-preview'
              ? { success: true, premium: 12, insuredAmount: 200, coveragePercent: 100 }
              : { success: true, status: 'accepted', premium: 12, insuredAmount: 200 },
      };
      if (route === 'insurance-preview') previews++;
      change(result, { route, previews, requests });
      return result;
    },
  });
  return { phase, requests, marks };
}
test('one top-up key, real route names, turn all-in and one deduplicated offer sequence', async () => {
  const f = fixture();
  await Promise.all([f.phase.beforeAction(users[0], state), f.phase.beforeAction(users[0], state)]);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.requests[1], f.requests[2]);
  assert.equal(f.requests[0].body.opId, '');
  assert.equal(f.phase.action({ ...state, stage: 'flop' }, { stack: 200, bet: 2 }), 'check');
  assert.equal(f.phase.action({ ...state, stage: 'turn' }, { stack: 200, bet: 2 }), 'all_in');
  const event = offer();
  await Promise.all([f.phase.event(event), f.phase.event(structuredClone(event))]);
  assert.equal(f.requests.length, 7);
  assert.ok(f.requests.slice(3).every((r) => r.actor === users[1].id));
  const complete = { type: 'hand_complete', table_id: tableId, hand_number: state.hand_number };
  await Promise.all([f.phase.event(complete), f.phase.event(complete)]);
  assert.equal(f.phase.finished, true);
  assert.deepEqual(
    f.marks.map((m) => m.phase),
    [
      'topup.before',
      'topup.malformed_refused',
      'topup.accepted',
      'topup.replayed',
      'insurance.offered',
      'insurance.malformed_refused',
      'insurance.accepted',
      'settlement.observed',
    ]
  );
  assert.ok(f.phase.observations().every((m) => !Object.hasOwn(m, 'passed')));
});
test('a successful malformed request stops the sequence before any valid retry', async () => {
  const f = fixture((r, { requests }) => {
    if (requests.length === 1) {
      r.status = 200;
      r.body = { success: true };
    }
  });
  await assert.rejects(f.phase.beforeAction(users[0], state));
  assert.equal(f.requests.length, 1);
});
test('changed quote on malformed acceptance refuses before valid acceptance', async () => {
  const f = fixture((r, { route, previews }) => {
    if (route === 'insurance-preview' && previews === 2) r.body.premium = 13;
  });
  await f.phase.beforeAction(users[0], state);
  await assert.rejects(f.phase.event(offer()), /REFUSAL_CHANGED_QUOTE/);
  assert.equal(
    f.requests.filter((r) => r.route === 'insurance' && r.body.coveragePercent === 100).length,
    0
  );
});
test('foreign, stale and non-turn offers cannot be substituted for eligibility', async () => {
  for (const mutate of [
    (x) => (x.table_id = users[0].id),
    (x) => x.hand_number++,
    (x) => (x.deadlineAt = 0),
    (x) => (x.street = 'flop'),
    (x) => (x.offers[0].playerId = tableId),
  ]) {
    const f = fixture();
    await f.phase.beforeAction(users[0], state);
    const event = offer();
    mutate(event);
    await assert.rejects(f.phase.event(event));
    assert.equal(f.requests.length, 3);
  }
});
test('a completed hand without a genuine offer is a refusal, not a proof', async () => {
  const f = fixture();
  await f.phase.beforeAction(users[0], state);
  await assert.rejects(
    f.phase.event({ type: 'hand_complete', table_id: tableId, hand_number: state.hand_number }),
    /NO_GENUINE_OFFER/
  );
  assert.equal(f.phase.finished, false);
});
