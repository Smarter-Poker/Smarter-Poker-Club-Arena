import assert from 'node:assert/strict';
import { chipCents } from './financial-topup-verifier.mjs';

// Selected two-player, ordinary standalone cash scenario only. The insurance
// receipt has already been compared with the genuine quote, outcome and bank.
// Null means the two live sockets have not both reflected the committed seats;
// malformed scope or incorrect durable accounting always throws immediately.
export function verifyFinancialSettlement({ owner, before, accepted, settled, insurance }) {
  const initial = before.facts,
    pending = accepted.facts,
    final = settled.facts;
  const actorIds = [...owner.actorIds].sort();
  for (const facts of [initial, pending, final]) {
    assert.deepEqual([...facts.actor_ids].sort(), actorIds, 'SETTLEMENT_ACTORS');
    assert.deepEqual(
      facts.scope,
      [[owner.tableId, owner.clubId, null, null, 'false', null]],
      'SETTLEMENT_SCOPE'
    );
    assert.equal(facts.seats.length, 2, 'SETTLEMENT_OCCUPANCY_COUNT');
    assert.deepEqual(facts.seats.map((row) => row[1]).sort(), actorIds, 'SETTLEMENT_OCCUPANTS');
    assert.deepEqual(facts.wallets.map((row) => row[0]).sort(), actorIds, 'SETTLEMENT_WALLETS');
  }
  assert.deepEqual(final.wallets, pending.wallets, 'SETTLEMENT_EXTRA_WALLET_CHANGE');
  for (const row of initial.seats) {
    const last = final.seats.find((seat) => seat[1] === row[1]);
    assert.equal(last[0], row[0], 'SETTLEMENT_OCCUPANCY_REPLACED');
    assert.equal(last[3], null, 'SETTLEMENT_ACTOR_LEFT');
    assert.ok(chipCents(last[2]) >= 0n, 'SETTLEMENT_NEGATIVE_STACK');
  }
  assert.equal(pending.addons.length, 1);
  assert.equal(final.addons.length, 1);
  assert.deepEqual(
    final.addons[0].slice(0, 4),
    pending.addons[0].slice(0, 4),
    'SETTLEMENT_ADDON_REPLACED'
  );
  assert.ok(final.addons[0][4] !== null, 'SETTLEMENT_ADDON_PENDING');
  assert.equal(chipCents(final.addons[0][5]), 1000n, 'SETTLEMENT_ADDON_APPLIED');
  assert.equal(chipCents(final.addons[0][6]), 0n, 'SETTLEMENT_ADDON_REFUNDED');
  assert.equal(final.hands.length, 1);
  assert.equal(final.hands[0][1], String(settled.entry.hand_number), 'SETTLEMENT_HAND');
  const rake = chipCents(final.hands[0][3]),
    bbj = chipCents(final.hands[0][4]);
  assert.ok(rake >= 0n && bbj >= 0n, 'SETTLEMENT_NEGATIVE_FEE');
  const total = (facts) =>
    facts.wallets.reduce((n, row) => n + chipCents(row[1]), 0n) +
    facts.seats.reduce((n, row) => n + chipCents(row[2]), 0n);
  const initialTotal = total(initial),
    finalTotal = total(final);
  assert.equal(
    finalTotal,
    initialTotal - rake - bbj - BigInt(insurance.premium_cents) + BigInt(insurance.payout_cents),
    'SETTLEMENT_PLAYER_CHIP_CONSERVATION'
  );
  assert.equal(settled.felt.length, 2, 'SETTLEMENT_FELT_COUNT');
  assert.deepEqual(
    settled.felt.map((sample) => sample.actor_id).sort(),
    actorIds,
    'SETTLEMENT_FELT_ACTORS'
  );
  let aligned = true;
  const states = [];
  for (const sample of settled.felt) {
    assert.ok(
      Number.isSafeInteger(sample.sequence) && sample.sequence >= 0,
      'SETTLEMENT_FELT_SEQUENCE'
    );
    const state = sample.state;
    assert.equal(state.table_id, owner.tableId, 'SETTLEMENT_FELT_TABLE');
    const next = state.hand_number === settled.entry.hand_number + 1;
    assert.ok(next || state.hand_number === settled.entry.hand_number, 'SETTLEMENT_FELT_HAND');
    assert.deepEqual(
      state.players.map((player) => player.user_id).sort(),
      actorIds,
      'SETTLEMENT_FELT_ROSTER'
    );
    const boundary = next
      ? state.stage === 'preflop'
      : ['waiting', 'showdown'].includes(state.stage);
    aligned &&= boundary;
    for (const player of state.players) {
      for (const value of [player.stack, player.bet])
        assert.ok(
          typeof value === 'number' && Number.isFinite(value) && value >= 0,
          'SETTLEMENT_FELT_MONEY'
        );
      // Completed-hand bets are historical contributions already awarded in
      // stacks. Only the following hand's live blinds are added back.
      const stack = chipCents(String(player.stack));
      const effective = stack + (next ? chipCents(String(player.bet)) : 0n);
      aligned &&= effective === chipCents(final.seats.find((row) => row[1] === player.user_id)[2]);
    }
    states.push({
      actor_id: sample.actor_id,
      sequence: sample.sequence,
      hand_number: state.hand_number,
    });
  }
  if (!aligned) return null;
  return {
    scope: 'settled-player-balances-and-two-felt-clients',
    product_certificate: false,
    initial_player_cents: String(initialTotal),
    final_player_cents: String(finalTotal),
    rake_cents: String(rake),
    bbj_cents: String(bbj),
    applied_addon_cents: '1000',
    clients: states,
  };
}
