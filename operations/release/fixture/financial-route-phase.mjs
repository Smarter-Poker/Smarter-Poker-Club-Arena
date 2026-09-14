import assert from 'node:assert/strict';

const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const money = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;

/** One real-client sequence. Checkpoints carry observations, never a certificate.
 * The caller supplies its two already authenticated actors and a fixed observer.
 * This module neither creates offers nor writes to the database.
 */
export function financialRoutePhase({ tableId, users, opId, request, checkpoint }) {
  assert.match(opId, /^[a-zA-Z0-9-]{8,64}$/);
  assert.equal(typeof request, 'function');
  assert.equal(typeof checkpoint, 'function');
  assert.equal(users.length, 2);
  let handNumber = null,
    topup,
    insurance,
    settlement,
    accepted = false,
    finished = false;
  let offerIdentity = null;
  const journal = [];
  async function mark(phase, observation) {
    const entry = structuredClone({ phase, hand_number: handNumber, ...observation });
    await checkpoint(entry);
    journal.push(entry);
  }
  async function response(user, method, route, body, expected) {
    const result = await request(user, method, route, body);
    assert.equal(
      result.status,
      expected,
      `FIXTURE_FINANCIAL_${route.toUpperCase().replaceAll('-', '_')}_HTTP`
    );
    assert.ok(record(result.body), 'FIXTURE_FINANCIAL_RESPONSE');
    assert.equal(result.body.success, expected === 200, 'FIXTURE_FINANCIAL_RESULT');
    return result.body;
  }
  async function topUp(user, state) {
    assert.equal(state.stage, 'preflop', 'FIXTURE_FINANCIAL_TOPUP_REQUIRES_DEALT_HAND');
    handNumber = state.hand_number;
    await mark('topup.before', { actor_id: user.id, state });
    const refused = await response(
      user,
      'POST',
      'addchips',
      { tableId, amount: 10, opId: '' },
      400
    );
    await mark('topup.malformed_refused', { actor_id: user.id, response: refused });
    const body = { tableId, amount: 10, opId };
    const first = await response(user, 'POST', 'addchips', body, 200);
    assert.equal(first.queued, true, 'FIXTURE_FINANCIAL_TOPUP_WAS_NOT_PENDING');
    assert.equal(first.applied, 10, 'FIXTURE_FINANCIAL_TOPUP_AMOUNT');
    await mark('topup.accepted', { actor_id: user.id, response: first });
    const replay = await response(user, 'POST', 'addchips', body, 200);
    await mark('topup.replayed', { actor_id: user.id, response: replay });
  }
  async function insure(event) {
    const offer = event.offers[0];
    const user = users.find((u) => u.id === offer.playerId);
    assert.ok(user, 'FIXTURE_FINANCIAL_FOREIGN_OFFER');
    assert.equal(event.offers.length, 1, 'FIXTURE_FINANCIAL_AMBIGUOUS_OFFER');
    assert.equal(event.street, 'turn', 'FIXTURE_FINANCIAL_OFFER_STREET');
    assert.ok(
      Array.isArray(event.board) && event.board.length === 4,
      'FIXTURE_FINANCIAL_DEALT_BOARD'
    );
    assert.ok(
      Number.isFinite(event.deadlineAt) && event.deadlineAt > Date.now(),
      'FIXTURE_FINANCIAL_OFFER_EXPIRED'
    );
    assert.ok(
      money(event.pot) && event.pot > 0 && money(offer.fullPremium) && offer.fullPremium > 0,
      'FIXTURE_FINANCIAL_OFFER_PRICE'
    );
    await mark('insurance.offered', { actor_id: user.id, offer: event });
    const query = { tableId, coveragePercent: 100 };
    const before = await response(user, 'GET', 'insurance-preview', query, 200);
    assert.ok(
      money(before.premium) && before.premium > 0 && money(before.insuredAmount),
      'FIXTURE_FINANCIAL_PREVIEW'
    );
    const refused = await response(
      user,
      'POST',
      'insurance',
      { tableId, response: 'accept', coveragePercent: '100' },
      400
    );
    const after = await response(user, 'GET', 'insurance-preview', query, 200);
    assert.deepEqual(after, before, 'FIXTURE_FINANCIAL_REFUSAL_CHANGED_QUOTE');
    await mark('insurance.malformed_refused', {
      actor_id: user.id,
      preview: before,
      response: refused,
    });
    assert.ok(event.deadlineAt > Date.now(), 'FIXTURE_FINANCIAL_OFFER_EXPIRED');
    const receipt = await response(
      user,
      'POST',
      'insurance',
      { tableId, response: 'accept', coveragePercent: 100 },
      200
    );
    assert.equal(receipt.status, 'accepted', 'FIXTURE_FINANCIAL_ACCEPTANCE');
    accepted = true;
    await mark('insurance.accepted', { actor_id: user.id, response: receipt });
  }
  return Object.freeze({
    get finished() {
      return finished;
    },
    async beforeAction(user, state) {
      assert.ok(!finished, 'FIXTURE_FINANCIAL_ALREADY_FINISHED');
      topup ??= topUp(user, structuredClone(state));
      await topup;
      assert.equal(state.hand_number, handNumber, 'FIXTURE_FINANCIAL_HAND_CHANGED');
    },
    action(state, player) {
      // Ordinary checked streets produce the board. All-in is an ordinary
      // action at the turn, so no forced cards or fabricated eligible offer.
      if (state.stage === 'turn') return 'all_in';
      const toCall = state.current_bet - player.bet;
      return toCall === 0 ? 'check' : toCall < player.stack ? 'call' : 'all_in';
    },
    async event(event) {
      if (!['insurance_offers', 'hand_complete'].includes(event.type)) return;
      assert.equal(event.table_id, tableId, 'FIXTURE_FINANCIAL_EVENT_TABLE');
      assert.equal(event.hand_number, handNumber, 'FIXTURE_FINANCIAL_EVENT_HAND');
      if (event.type === 'insurance_offers') {
        const identity = JSON.stringify(event);
        if (offerIdentity !== null) {
          assert.equal(identity, offerIdentity, 'FIXTURE_FINANCIAL_OFFER_CHANGED');
          return insurance;
        }
        offerIdentity = identity;
        insurance = insure(structuredClone(event));
        return insurance;
      }
      settlement ??= (async () => {
        assert.ok(insurance, 'FIXTURE_FINANCIAL_NO_GENUINE_OFFER');
        await insurance;
        assert.equal(accepted, true, 'FIXTURE_FINANCIAL_NOT_ACCEPTED');
        finished = true;
        // This event precedes some durable settlement work. The independent
        // checkpoint reader must await that exact hand's committed completion.
        await mark('settlement.observed', { event });
      })();
      return settlement;
    },
    observations() {
      return structuredClone(journal);
    },
  });
}
