import assert from 'node:assert/strict';
import { validateFinancialData, validateFinancial } from './component-observation-protocol.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const phases = ['topup.before', 'topup.malformed_refused', 'topup.accepted', 'topup.replayed'];

// PostgreSQL numeric text is the authority. Refuse fractional cents, exponent
// notation, coercion, and values that JavaScript would round before comparison.
export function chipCents(value) {
  assert.equal(typeof value, 'string', 'FINANCIAL_NUMERIC_TEXT');
  assert.match(value, /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2}0*)?$/, 'FINANCIAL_CENTS');
  assert.ok(value.length <= 64, 'FINANCIAL_NUMERIC_SIZE');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
  return negative ? -cents : cents;
}

function newRows(before, after, label) {
  const old = new Map(before.map((row) => [row[0], row]));
  assert.equal(old.size, before.length, `FINANCIAL_${label}_DUPLICATE`);
  assert.equal(
    new Set(after.map((row) => row[0])).size,
    after.length,
    `FINANCIAL_${label}_DUPLICATE`
  );
  for (const [id, row] of old) {
    assert.deepEqual(
      after.find((candidate) => candidate[0] === id),
      row,
      `FINANCIAL_${label}_HISTORY_CHANGED`
    );
  }
  return after.filter((row) => !old.has(row[0]));
}

/** The independent observer supplies its own actor/table/club/attempt binding.
 * Four fixed read snapshots prove only the pending top-up database boundary.
 * This is not a claim about Auth, HTTP, engine memory, delivery or settlement.
 */
export function createTopupVerifier({ tableId, clubId, actorIds, financial }) {
  for (const id of [tableId, clubId, ...actorIds]) assert.match(id, uuid);
  assert.equal(actorIds.length, 2);
  assert.equal(new Set(actorIds).size, 2);
  validateFinancial(financial);
  const binding = structuredClone({ tableId, clubId, actorIds, financial });
  const actor = binding.actorIds[financial.actor_index];
  const key = `addon:${tableId}:${actor}:${financial.op_id}`;
  let step = 0,
    baseline,
    accepted,
    failed = false;
  function identity(data) {
    validateFinancialData(data);
    assert.deepEqual(data.actor_ids, binding.actorIds, 'FINANCIAL_ACTOR_BINDING');
    assert.deepEqual(
      data.scope,
      [[tableId, clubId, null, null, 'false', null]],
      'FINANCIAL_STANDALONE_CASH_SCOPE'
    );
    assert.equal(data.banks.length, 1, 'FINANCIAL_BANK_COUNT');
    assert.deepEqual(data.banks[0].slice(0, 2), ['club', clubId], 'FINANCIAL_BANK_OWNER');
    if (data.banks[0][2] === null) assert.equal(data.banks[0][3], null, 'FINANCIAL_ABSENT_BANK');
    else {
      assert.match(data.banks[0][2], uuid);
      chipCents(data.banks[0][3]);
    }
    assert.equal(data.wallets.length, 2, 'FINANCIAL_WALLETS');
    assert.deepEqual(
      data.wallets.map((row) => row[0]).sort(),
      [...binding.actorIds].sort(),
      'FINANCIAL_WALLET_OWNERS'
    );
    assert.equal(data.seats.length, 2, 'FINANCIAL_SEATS');
    assert.equal(new Set(data.seats.map((row) => row[0])).size, 2, 'FINANCIAL_OCCUPANCIES');
    assert.deepEqual(
      data.seats.map((row) => row[1]).sort(),
      [...binding.actorIds].sort(),
      'FINANCIAL_SEAT_OWNERS'
    );
    for (const row of data.seats) assert.equal(row[3], null, 'FINANCIAL_SEAT_LEFT');
    for (const row of data.wallets) assert.ok(chipCents(row[1]) >= 0n);
    for (const row of data.seats) assert.ok(chipCents(row[2]) >= 0n);
  }
  function acceptedTopup(data) {
    for (const name of ['scope', 'banks', 'seats', 'hands', 'offers', 'insurance', 'commits']) {
      assert.deepEqual(data[name], baseline[name], `FINANCIAL_TOPUP_CHANGED_${name.toUpperCase()}`);
    }
    for (const [id, balance] of baseline.wallets) {
      const after = data.wallets.find((row) => row[0] === id)[1];
      assert.equal(
        chipCents(balance) - chipCents(after),
        id === actor ? 1000n : 0n,
        'FINANCIAL_TOPUP_WALLET_DELTA'
      );
    }
    assert.equal(data.addons.length, 1, 'FINANCIAL_TOPUP_PENDING_COUNT');
    const pending = data.addons[0];
    assert.match(pending[0], uuid);
    assert.equal(pending[1], actor);
    assert.equal(chipCents(pending[2]), 1000n);
    assert.deepEqual(
      pending.slice(3),
      ['addon', null, null, null],
      'FINANCIAL_TOPUP_PENDING_STATE'
    );
    assert.equal(data.addon_keys.length, 1);
    assert.deepEqual(
      data.addon_keys[0].filter((_, index) => index !== 2),
      [key, actor, 'false', tableId]
    );
    assert.equal(chipCents(data.addon_keys[0][2]), 1000n);
    assert.equal(data.receipts.length, 1, 'FINANCIAL_TOPUP_RECEIPT_COUNT');
    const receipt = data.receipts[0];
    assert.deepEqual(receipt.slice(0, 2), ['cash_addon', key]);
    assert.deepEqual(
      JSON.parse(receipt[2]),
      {
        door: 'atomic_table_addon',
        user_id: actor,
        table_id: tableId,
        amount: 10,
        apply_to_seat: false,
      },
      'FINANCIAL_TOPUP_RECEIPT_REQUEST'
    );
    for (const timestamp of receipt.slice(4))
      assert.ok(
        typeof timestamp === 'string' && timestamp.length > 0,
        'FINANCIAL_TOPUP_INCOMPLETE_RECEIPT'
      );
    const response = JSON.parse(receipt[3]);
    assert.deepEqual(Object.keys(response), ['balance']);
    assert.equal(typeof response.balance, 'number');
    assert.equal(
      chipCents(String(response.balance)),
      chipCents(data.wallets.find((row) => row[0] === actor)[1]),
      'FINANCIAL_TOPUP_RECEIPT_BALANCE'
    );
    const ledger = newRows(baseline.ledger, data.ledger, 'LEDGER');
    assert.equal(ledger.length, 1, 'FINANCIAL_TOPUP_LEDGER_COUNT');
    assert.deepEqual(
      ledger[0].slice(1, 5),
      ['player_wallet', actor, 'table_stack', tableId],
      'FINANCIAL_TOPUP_COUNTERPART'
    );
    assert.equal(chipCents(ledger[0][5]), 1000n);
    assert.equal(ledger[0][6], 'addon');
    const transactions = newRows(
      baseline.wallet_transactions,
      data.wallet_transactions,
      'WALLET_TRANSACTION'
    );
    assert.equal(transactions.length, 1, 'FINANCIAL_TOPUP_TRANSACTION_COUNT');
    assert.deepEqual(transactions[0].slice(1, 4), [actor, 'debit', 'addon']);
    assert.equal(chipCents(transactions[0][4]), 1000n);
    assert.equal(
      chipCents(transactions[0][5]),
      chipCents(data.wallets.find((row) => row[0] === actor)[1])
    );
  }
  return Object.freeze({
    observe(entry, raw) {
      try {
        assert.ok(!failed && step < phases.length, 'FINANCIAL_TOPUP_VERIFIER_CLOSED');
        assert.equal(entry.phase, phases[step], 'FINANCIAL_TOPUP_PHASE_ORDER');
        assert.equal(entry.hand_number, binding.financial.hand_number, 'FINANCIAL_TOPUP_HAND');
        assert.equal(entry.actor_id, actor, 'FINANCIAL_TOPUP_ACTOR');
        const data = structuredClone(raw);
        identity(data);
        if (step === 0) {
          for (const name of [
            'addons',
            'addon_keys',
            'receipts',
            'hands',
            'offers',
            'insurance',
            'commits',
          ]) {
            assert.equal(data[name].length, 0, 'FINANCIAL_TOPUP_NONEMPTY_BASELINE');
          }
          for (const row of data.wallets)
            assert.equal(chipCents(row[1]), 180000n, 'FINANCIAL_CANONICAL_FUNDING');
          for (const row of data.seats)
            assert.equal(chipCents(row[2]), 20000n, 'FINANCIAL_CANONICAL_BUYIN');
          baseline = data;
        } else if (step === 1) {
          assert.deepEqual(data, baseline, 'FINANCIAL_TOPUP_REFUSAL_MUTATED');
        } else if (step === 2) {
          acceptedTopup(data);
          accepted = data;
        } else {
          assert.deepEqual(data, accepted, 'FINANCIAL_TOPUP_REPLAY_MUTATED');
        }
        step++;
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    receipt() {
      assert.ok(!failed && step === phases.length, 'FINANCIAL_TOPUP_INCOMPLETE');
      return {
        scope: 'pending-topup-fixed-database-observations',
        ...structuredClone(binding),
        snapshots: step,
        debited_cents: '1000',
        pending_cents: '1000',
        ledger_id: newRows(baseline.ledger, accepted.ledger, 'LEDGER')[0][0],
        pending_id: accepted.addons[0][0],
        receipt_key: key,
        product_certificate: false,
      };
    },
  });
}
