// Verifier adversarial inputs. These fabricated rows are never product proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FINANCIAL_SECTIONS } from '../../operations/release/native/component-observation-protocol.mjs';
import {
  chipCents,
  createTopupVerifier,
} from '../../operations/release/native/financial-topup-verifier.mjs';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding = {
  tableId: id(1),
  clubId: id(2),
  actorIds: [id(3), id(4)],
  financial: { actor_index: 0, op_id: 'verifier-test-0001', hand_number: 1000001 },
};
const phases = ['topup.before', 'topup.malformed_refused', 'topup.accepted', 'topup.replayed'];
const entry = (index) => ({ phase: phases[index], hand_number: 1000001, actor_id: id(3) });
function snapshots() {
  const baseline = Object.fromEntries(Object.keys(FINANCIAL_SECTIONS).map((name) => [name, []]));
  baseline.actor_ids = [...binding.actorIds];
  baseline.scope = [[id(1), id(2), null, null, 'false', null]];
  baseline.banks = [['club', id(2), null, null]];
  baseline.wallets = [
    [id(3), '1800.00'],
    [id(4), '1800.00'],
  ];
  baseline.seats = [
    [id(5), id(3), '200.00', null],
    [id(6), id(4), '200.00', null],
  ];
  baseline.ledger = [
    [id(7), 'player_wallet', id(3), 'table_stack', id(1), '200.00', 'buyin', null],
    [id(8), 'player_wallet', id(4), 'table_stack', id(1), '200.00', 'buyin', null],
  ];
  const accepted = structuredClone(baseline);
  const key = `addon:${id(1)}:${id(3)}:verifier-test-0001`;
  accepted.wallets[0][1] = '1790.00';
  accepted.addons = [[id(9), id(3), '10.00', 'addon', null, null, null]];
  accepted.addon_keys = [[key, id(3), '10', 'false', id(1)]];
  accepted.receipts = [
    [
      'cash_addon',
      key,
      JSON.stringify({
        door: 'atomic_table_addon',
        amount: 10,
        user_id: id(3),
        table_id: id(1),
        apply_to_seat: false,
      }),
      '{"balance":1790}',
      '2026-09-12 00:00:00+00',
      '2026-09-12 00:00:00+00',
    ],
  ];
  accepted.ledger.push([id(10), 'player_wallet', id(3), 'table_stack', id(1), '10', 'addon', null]);
  accepted.wallet_transactions.push([id(11), id(3), 'debit', 'addon', '10', '1790']);
  return [baseline, structuredClone(baseline), accepted, structuredClone(accepted)];
}
function verify(rows, owner = binding) {
  const verifier = createTopupVerifier(owner);
  rows.forEach((data, i) => verifier.observe(entry(i), data));
  return verifier.receipt();
}
test('pending debit, counterpart, completed receipt and unchanged replay have a scoped receipt', () => {
  const receipt = verify(snapshots());
  assert.equal(receipt.debited_cents, '1000');
  assert.equal(receipt.pending_id, id(9));
  assert.equal(receipt.product_certificate, false);
});
test('numeric comparisons retain exact cents beyond floating-point precision', () => {
  assert.equal(chipCents('9007199254740993.25'), 900719925474099325n);
  assert.equal(chipCents('-12.5000'), -1250n);
  assert.equal(chipCents('0.01'), 1n);
  for (const value of [1, null, 'NaN', 'Infinity', '1e3', '1.001', '1.0010', '01', ' 1', '']) {
    assert.throws(() => chipCents(value));
  }
});
for (const [name, mutate] of [
  [
    'a debit after malformed refusal',
    (r) => {
      r[1].wallets[0][1] = '1790';
    },
  ],
  [
    'a replay debit',
    (r) => {
      r[3].wallets[0][1] = '1780';
    },
  ],
  [
    'a second pending entitlement',
    (r) => {
      r[2].addons.push([id(12), id(3), '10', 'addon', null, null, null]);
    },
  ],
  [
    'the wrong bank',
    (r) => {
      r[2].banks[0][1] = id(12);
    },
  ],
  [
    'a missing counterpart',
    (r) => {
      r[2].ledger.pop();
    },
  ],
  [
    'an unrelated counterpart',
    (r) => {
      r[2].ledger.at(-1)[4] = id(12);
    },
  ],
  [
    'a wallet credit hiding the missing debit',
    (r) => {
      r[2].ledger.at(-1)[1] = 'issuance_reserve';
    },
  ],
  [
    'rewritten ledger history',
    (r) => {
      r[2].ledger[0][5] = '199';
    },
  ],
  [
    'duplicate ledger identities',
    (r) => {
      r[2].ledger.at(-1)[0] = id(7);
    },
  ],
  [
    'wrong wallet owner',
    (r) => {
      r[2].wallets[1][0] = id(12);
    },
  ],
  [
    'another actor charged too',
    (r) => {
      r[2].wallets[1][1] = '1790';
    },
  ],
  [
    'premature seat credit',
    (r) => {
      r[2].seats[0][2] = '210';
    },
  ],
  [
    'retired seat',
    (r) => {
      r[2].seats[0][3] = '2026-09-12 00:00:00+00';
    },
  ],
  [
    'incomplete receipt',
    (r) => {
      r[2].receipts[0][5] = null;
    },
  ],
  [
    'different receipt request',
    (r) => {
      const request = JSON.parse(r[2].receipts[0][2]);
      request.amount = 20;
      r[2].receipts[0][2] = JSON.stringify(request);
    },
  ],
  [
    'wrong returned balance',
    (r) => {
      r[2].receipts[0][3] = '{"balance":1800}';
    },
  ],
  [
    'wrong operation key',
    (r) => {
      r[2].addon_keys[0][0] += 'x';
    },
  ],
  [
    'wrong receipt key',
    (r) => {
      r[2].receipts[0][1] += 'x';
    },
  ],
  [
    'already-resolved pending amount',
    (r) => {
      r[2].addons[0][5] = '10';
    },
  ],
  [
    'a substituted union table',
    (r) => {
      for (const data of r) data.scope[0][2] = id(12);
    },
  ],
  [
    'a substituted actor order',
    (r) => {
      for (const data of r) data.actor_ids.reverse();
    },
  ],
  [
    'fractional chips',
    (r) => {
      r[2].addons[0][2] = '10.001';
    },
  ],
]) {
  test(`refuses ${name}`, () => {
    const rows = snapshots();
    mutate(rows);
    assert.throws(() => verify(rows));
  });
}
test('an incomplete, reordered or previously rejected proof cannot produce a receipt', () => {
  const rows = snapshots(),
    verifier = createTopupVerifier(binding);
  assert.throws(() => verifier.receipt(), /INCOMPLETE/);
  assert.throws(() => verifier.observe(entry(1), rows[1]), /PHASE_ORDER/);
  assert.throws(() => verifier.observe(entry(0), rows[0]), /CLOSED/);
  assert.throws(() => verifier.receipt(), /INCOMPLETE/);
});
test('the verifier pins caller-owned bindings and copies snapshots before later mutation', () => {
  const owner = structuredClone(binding),
    rows = snapshots(),
    verifier = createTopupVerifier(owner);
  verifier.observe(entry(0), rows[0]);
  owner.actorIds.reverse();
  owner.financial.hand_number++;
  rows[0].wallets[0][1] = '0';
  for (let i = 1; i < rows.length; i++) verifier.observe(entry(i), rows[i]);
  assert.deepEqual(verifier.receipt().actorIds, binding.actorIds);
});
