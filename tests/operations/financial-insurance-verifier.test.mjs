// Adversarial fabricated observations, never a funded route certificate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FINANCIAL_SECTIONS } from '../../operations/release/native/component-observation-protocol.mjs';
import { verifyInsuranceEconomics } from '../../operations/release/native/financial-insurance-verifier.mjs';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(branch = 'premium', opening = null) {
  const facts = Object.fromEntries(Object.keys(FINANCIAL_SECTIONS).map((key) => [key, []]));
  Object.assign(facts, {
    actor_ids: [id(3), id(4)],
    scope: [[id(1), id(2), null, null, 'false', null]],
    banks: [['club', id(2), opening === null ? null : id(5), opening]],
    offers: [[id(6), id(4), 'offered', '12', '200', 'turn', '1000001']],
    ledger: [[id(7), 'player_wallet', id(3), 'table_stack', id(1), '200', 'buyin', null]],
  });
  const offered = {
    entry: {
      phase: 'insurance.offered',
      actor_id: id(4),
      hand_number: 1000001,
      offer: {
        type: 'insurance_offers',
        table_id: id(1),
        hand_number: 1000001,
        street: 'turn',
        offers: [{ playerId: id(4), fullPremium: 12, fullInsuredAmount: 200 }],
      },
    },
    facts,
  };
  const accepted = {
    entry: {
      phase: 'insurance.accepted',
      actor_id: id(4),
      hand_number: 1000001,
      response: { success: true, status: 'accepted', premium: 12, insuredAmount: 200 },
    },
    facts: structuredClone(facts),
  };
  const premium = branch === 'premium' ? 12 : 0,
    payout = branch === 'payout' ? 200 : 0;
  const after = structuredClone(facts);
  after.banks[0] = ['club', id(2), id(5), String(Number(opening) + premium - payout)];
  after.insurance = [
    [
      id(8),
      id(4),
      String(premium),
      '200',
      String(payout),
      String(payout - premium),
      String(branch !== 'payout'),
      'club',
      id(2),
    ],
  ];
  if (premium || payout)
    after.ledger.push([
      id(9),
      ...(premium
        ? ['table_stack', id(1), 'insurance_bank', id(5)]
        : ['insurance_bank', id(5), 'table_stack', id(1)]),
      String(premium || payout),
      'insurance',
      null,
    ]);
  const settled = {
    entry: {
      phase: 'settlement.observed',
      hand_number: 1000001,
      event: {
        type: 'hand_complete',
        table_id: id(1),
        hand_number: 1000001,
        winner_ids: branch === 'push' ? [id(3), id(4)] : [branch === 'premium' ? id(4) : id(3)],
      },
    },
    facts: after,
  };
  return {
    owner: { tableId: id(1), clubId: id(2), actorIds: [id(3), id(4)] },
    offered,
    accepted,
    settled,
  };
}
for (const branch of ['premium', 'payout', 'push']) {
  test(`${branch} agrees with the actual quote, receipt, signed bank and counterpart`, () => {
    const result = verifyInsuranceEconomics(fixture(branch));
    assert.equal(result.branch, branch);
    assert.equal(result.product_certificate, false);
    assert.equal(
      result.bank_delta_cents,
      branch === 'premium' ? '1200' : branch === 'payout' ? '-20000' : '0'
    );
  });
}
test('existing signed bank identity survives settlement', () => {
  const f = fixture('payout', '-80.50');
  const before = structuredClone(f);
  assert.equal(verifyInsuranceEconomics(f).bank_delta_cents, '-20000');
  assert.deepEqual(f, before);
});
for (const [name, mutate] of [
  [
    'wrong actor',
    (f) => {
      f.accepted.entry.actor_id = id(3);
    },
  ],
  [
    'wrong hand',
    (f) => {
      f.settled.entry.hand_number++;
    },
  ],
  [
    'union scope',
    (f) => {
      f.settled.facts.scope[0][2] = id(20);
    },
  ],
  [
    'wrong quote receipt',
    (f) => {
      f.accepted.entry.response.premium = 13;
    },
  ],
  [
    'cashout substituted for acceptance',
    (f) => {
      f.accepted.entry.response.status = 'cashed_out';
    },
  ],
  [
    'invalid quote',
    (f) => {
      f.offered.entry.offer.offers[0].fullPremium = NaN;
    },
  ],
  [
    'audit offer mismatch',
    (f) => {
      f.offered.facts.offers[0][3] = '13';
    },
  ],
  [
    'missing offered row',
    (f) => {
      f.settled.facts.offers = [];
    },
  ],
  [
    'changed offered row',
    (f) => {
      f.settled.facts.offers[0][3] = '13';
    },
  ],
  [
    'duplicated winner',
    (f) => {
      f.settled.entry.event.winner_ids = [id(4), id(4)];
    },
  ],
  [
    'unknown winner',
    (f) => {
      f.settled.entry.event.winner_ids = [id(20)];
    },
  ],
  [
    'missing winner list',
    (f) => {
      delete f.settled.entry.event.winner_ids;
    },
  ],
  [
    'receipt premium',
    (f) => {
      f.settled.facts.insurance[0][2] = '13';
    },
  ],
  [
    'receipt payout',
    (f) => {
      f.settled.facts.insurance[0][4] = '1';
    },
  ],
  [
    'receipt net',
    (f) => {
      f.settled.facts.insurance[0][5] = '12';
    },
  ],
  [
    'receipt outcome',
    (f) => {
      f.settled.facts.insurance[0][6] = 'false';
    },
  ],
  [
    'receipt wallet substituted for club',
    (f) => {
      f.settled.facts.insurance[0][8] = id(5);
    },
  ],
  [
    'duplicate receipt',
    (f) => {
      f.settled.facts.insurance.push([...f.settled.facts.insurance[0]]);
    },
  ],
  [
    'bank delta',
    (f) => {
      f.settled.facts.banks[0][3] = '24';
    },
  ],
  [
    'fractional cents',
    (f) => {
      f.settled.facts.banks[0][3] = '12.001';
    },
  ],
  [
    'bank replaced',
    (f) => {
      f.offered.facts.banks[0] = ['club', id(2), id(20), '0'];
    },
  ],
  [
    'missing ledger',
    (f) => {
      f.settled.facts.ledger.pop();
    },
  ],
  [
    'ledger club substituted for wallet',
    (f) => {
      f.settled.facts.ledger.at(-1)[4] = id(2);
    },
  ],
  [
    'ledger wrong direction',
    (f) => {
      f.settled.facts.ledger.at(-1)[1] = 'player_wallet';
    },
  ],
  [
    'ledger amount',
    (f) => {
      f.settled.facts.ledger.at(-1)[5] = '24';
    },
  ],
  [
    'history rewrite',
    (f) => {
      f.settled.facts.ledger[0][5] = '201';
    },
  ],
  [
    'extra bank transfer',
    (f) => {
      f.settled.facts.ledger.push([
        id(20),
        'insurance_bank',
        id(5),
        'table_stack',
        id(1),
        '1',
        'other',
        null,
      ]);
    },
  ],
])
  test(`refuses ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => verifyInsuranceEconomics(f));
  });

test('a losing insured player cannot be charged a premium', () => {
  const f = fixture('payout');
  f.settled.facts.insurance[0][2] = '12';
  assert.throws(() => verifyInsuranceEconomics(f), /RECEIPT_PREMIUM/);
});
test('a push cannot create a zero-value insurance ledger row', () => {
  const f = fixture('push');
  f.settled.facts.ledger.push([
    id(9),
    'table_stack',
    id(1),
    'insurance_bank',
    id(5),
    '0',
    'insurance',
    null,
  ]);
  assert.throws(() => verifyInsuranceEconomics(f), /LEDGER_COUNT/);
});
