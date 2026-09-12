// Synthetic protocol inputs only: no Auth, engine, bank or product certificate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FINANCIAL_SECTIONS } from '../../operations/release/native/component-observation-protocol.mjs';
import { createFinancialCheckpointObserver } from '../../operations/release/native/financial-checkpoint-observer.mjs';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = {
  tableId: id(1),
  clubId: id(2),
  actorIds: [id(3), id(4)],
  opId: 'checkpoint-0001',
  sourceSha: 'a'.repeat(40),
};
const hand = 1000001;
const names = [
  'topup.before',
  'topup.malformed_refused',
  'topup.accepted',
  'topup.replayed',
  'insurance.offered',
  'insurance.malformed_refused',
  'insurance.accepted',
  'settlement.observed',
];
function fixture(overrides = {}) {
  const initial = Object.fromEntries(Object.keys(FINANCIAL_SECTIONS).map((name) => [name, []]));
  Object.assign(initial, {
    actor_ids: [...owner.actorIds],
    scope: [[id(1), id(2), null, null, 'false', null]],
    banks: [['club', id(2), null, null]],
    wallets: [
      [id(3), '1800'],
      [id(4), '1800'],
    ],
    seats: [
      [id(5), id(3), '200', null],
      [id(6), id(4), '200', null],
    ],
  });
  const accepted = structuredClone(initial),
    key = `addon:${id(1)}:${id(3)}:${owner.opId}`;
  accepted.wallets[0][1] = '1790';
  accepted.addons = [[id(7), id(3), '10', 'addon', null, null, null]];
  accepted.addon_keys = [[key, id(3), '10', 'false', id(1)]];
  accepted.receipts = [
    [
      'cash_addon',
      key,
      JSON.stringify({
        door: 'atomic_table_addon',
        user_id: id(3),
        table_id: id(1),
        amount: 10,
        apply_to_seat: false,
      }),
      '{"balance":1790}',
      '2026-09-12 00:00:00+00',
      '2026-09-12 00:00:00+00',
    ],
  ];
  accepted.ledger = [[id(8), 'player_wallet', id(3), 'table_stack', id(1), '10', 'addon', null]];
  accepted.wallet_transactions = [[id(9), id(3), 'debit', 'addon', '10', '1790']];
  const offered = structuredClone(accepted);
  offered.offers = [[id(10), id(4), 'offered', '12', '200', 'turn', String(hand)]];
  const final = structuredClone(offered);
  final.addons[0].splice(4, 3, '2026-09-12 00:00:01+00', '10', '0');
  final.hands = [[id(11), String(hand), '400', '3', '0']];
  final.commits = [
    [
      id(11),
      'b'.repeat(64),
      '2026-09-12 00:00:01+00',
      '2026-09-12 00:00:02+00',
      'c'.repeat(64),
      JSON.stringify({
        ok: true,
        hand_id: id(11),
        hand_number: hand,
        insurance: 1,
        pending_addons: 1,
      }),
    ],
  ];
  final.insurance = [[id(12), id(4), '12', '200', '0', '-12', 'true', 'club', id(2)]];
  final.banks = [['club', id(2), id(13), '12']];
  final.ledger.push([
    id(14),
    'table_stack',
    id(1),
    'insurance_bank',
    id(13),
    '12',
    'insurance',
    null,
  ]);
  const rows = [initial, initial, accepted, accepted, offered, offered, offered, final].map((r) =>
    structuredClone(r)
  );
  const entries = names.map((phase, i) => ({
    phase,
    hand_number: hand,
    ...(i < 7 ? { actor_id: i < 4 ? id(3) : id(4) } : {}),
  }));
  entries[4].offer = {
    type: 'insurance_offers',
    table_id: id(1),
    hand_number: hand,
    street: 'turn',
    offers: [{ playerId: id(4), fullPremium: 12, fullInsuredAmount: 200 }],
  };
  entries[6].response = { success: true, status: 'accepted', premium: 12, insuredAmount: 200 };
  entries[7].event = {
    type: 'hand_complete',
    table_id: id(1),
    hand_number: hand,
    winner_ids: [id(4)],
  };
  let index = 0,
    clock = 0,
    instance = 'owned-boot-1',
    source = owner.sourceSha;
  const reads = [];
  const observer = createFinancialCheckpointObserver({
    owner,
    observations: {
      binding: { table_id: id(1) },
      financialFacts:
        overrides.financialFacts ??
        (async (binding) => {
          reads.push(structuredClone(binding));
          return rows[index];
        }),
    },
    readEngineIdentity:
      overrides.readEngineIdentity ??
      (async () => ({ source_sha: source, instance_id: instance, running: true })),
    sampleFelt:
      overrides.sampleFelt ??
      (async () =>
        owner.actorIds.map((actor_id) => ({
          actor_id,
          sequence: index,
          state: { table_id: id(1), hand_number: hand },
        }))),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return {
    rows,
    entries,
    reads,
    observer,
    setSource: (v) => {
      source = v;
    },
    setInstance: (v) => {
      instance = v;
    },
    advance: (ms) => {
      clock += ms;
    },
    run: async (i) => {
      index = i;
      await observer.checkpoint(entries[i]);
    },
  };
}
test('ordered fixed observations compare the scoped economics without certifying the product', async () => {
  const f = fixture();
  await f.observer.start();
  for (let i = 0; i < 8; i++) await f.run(i);
  const result = f.observer.observations();
  assert.equal(result.checkpoints.length, 8);
  assert.equal(result.topup_database.debited_cents, '1000');
  assert.equal(result.insurance_database.premium_cents, '1200');
  assert.equal(result.product_certificate, false);
  assert.ok(result.remaining.includes('felt-to-database settlement reconciliation'));
  for (const read of f.reads)
    assert.deepEqual(read, { actor_index: 0, hand_number: hand, op_id: owner.opId });
  result.checkpoints[0].facts.wallets[0][1] = '0';
  assert.equal(f.observer.observations().checkpoints[0].facts.wallets[0][1], '1800');
});
test('changed actor or hand cannot repin an active sequence', async () => {
  for (const mutate of [
    (f) => {
      f.entries[1].hand_number++;
    },
    (f) => {
      f.entries[1].actor_id = id(4);
    },
  ]) {
    const f = fixture();
    await f.observer.start();
    await f.run(0);
    mutate(f);
    await assert.rejects(f.run(1));
    await assert.rejects(f.run(0), /CLOSED/);
  }
});
test('insurance refusal cannot mutate fixed financial facts', async () => {
  const f = fixture();
  await f.observer.start();
  for (let i = 0; i < 5; i++) await f.run(i);
  f.rows[5].wallets[1][1] = '1799';
  await assert.rejects(f.run(5), /INSURANCE_REFUSAL_MUTATED/);
});
test('a hand-complete event cannot substitute for durable post-commit completion', async () => {
  const f = fixture();
  await f.observer.start();
  for (let i = 0; i < 7; i++) await f.run(i);
  f.rows[7].commits[0][3] = null;
  await assert.rejects(f.run(7), /PERSISTENCE_TIMEOUT/);
  assert.throws(() => f.observer.observations(), /CLOSED/);
});
test('a restarted engine cannot inherit the first engine observation', async () => {
  const f = fixture();
  await f.observer.start();
  for (let i = 0; i < 7; i++) await f.run(i);
  f.setInstance('replacement-boot');
  await assert.rejects(f.run(7), /ENGINE_REPLACED/);
});
test('the observer refuses a different source before admitting route checkpoints', async () => {
  const f = fixture();
  f.setSource('b'.repeat(40));
  await assert.rejects(f.observer.start(), /ENGINE_SOURCE/);
  assert.deepEqual(f.reads, []);
  await assert.rejects(f.run(0), /CLOSED/);
});
test('the original budget and required checkpoint order are not renewable', async () => {
  const f = fixture();
  await f.observer.start();
  await f.run(0);
  f.advance(120001);
  await assert.rejects(f.run(1), /EXPIRED/);
  const g = fixture();
  await g.observer.start();
  await assert.rejects(g.run(1), /ORDER/);
});
test('wrong table, hand identity or settlement counters refuse', async () => {
  for (const mutate of [
    (f) => {
      f.rows[7].scope[0][0] = id(99);
    },
    (f) => {
      f.rows[7].hands[0][0] = id(99);
    },
    (f) => {
      const p = JSON.parse(f.rows[7].commits[0][5]);
      p.pending_addons = 2;
      f.rows[7].commits[0][5] = JSON.stringify(p);
    },
  ]) {
    const f = fixture();
    await f.observer.start();
    for (let i = 0; i < 7; i++) await f.run(i);
    mutate(f);
    await assert.rejects(f.run(7));
  }
});

for (const stage of [
  'initial engine identity',
  'financial facts',
  'felt state',
  'final engine identity',
]) {
  test(`the original deadline bounds a hung ${stage} callback`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let resolveLate;
    const pending = new Promise((resolve) => {
      resolveLate = resolve;
    });
    let identityReads = 0;
    const identity = { source_sha: owner.sourceSha, instance_id: 'owned-boot-1', running: true };
    const f = fixture({
      ...(stage === 'financial facts' ? { financialFacts: () => pending } : {}),
      ...(stage === 'felt state' ? { sampleFelt: () => pending } : {}),
      ...(['initial engine identity', 'final engine identity'].includes(stage)
        ? {
            readEngineIdentity: () =>
              ++identityReads === (stage === 'initial engine identity' ? 1 : 2)
                ? pending
                : Promise.resolve(identity),
          }
        : {}),
    });
    if (stage !== 'initial engine identity') await f.observer.start();
    if (stage === 'final engine identity') for (let i = 0; i < 7; i++) await f.run(i);
    let result = 'pending';
    const operation =
      stage === 'initial engine identity'
        ? f.observer.start()
        : f.run(stage === 'final engine identity' ? 7 : 0);
    operation.then(
      () => {
        result = 'resolved';
      },
      (error) => {
        result = error.message;
      }
    );
    await new Promise(setImmediate);
    f.advance(120000);
    context.mock.timers.tick(120000);
    await new Promise(setImmediate);
    assert.match(result, /FINANCIAL_CHECKPOINT_DEADLINE/);
    resolveLate(identity);
    await new Promise(setImmediate);
    assert.throws(() => f.observer.observations(), /CLOSED/);
    await assert.rejects(f.observer.start(), /ALREADY_STARTED/);
  });
}

test('the initial identity read consumes the original budget instead of renewing it', async () => {
  let resolveIdentity;
  const f = fixture({
    readEngineIdentity: () =>
      new Promise((resolve) => {
        resolveIdentity = resolve;
      }),
  });
  const starting = f.observer.start();
  await new Promise(setImmediate);
  f.advance(119999);
  resolveIdentity({ source_sha: owner.sourceSha, instance_id: 'owned-boot-1', running: true });
  await starting;
  f.advance(2);
  await assert.rejects(f.run(0), /EXPIRED/);
});

for (const [checkpoint, budget] of [
  [4, 5000],
  [7, 15000],
]) {
  test(`a hung persistence read keeps the ${budget}ms checkpoint deadline`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let index = 0,
      hang = false;
    const f = fixture({
      financialFacts: () => (hang ? new Promise(() => {}) : Promise.resolve(f.rows[index])),
    });
    await f.observer.start();
    for (; index < checkpoint; index++) await f.run(index);
    hang = true;
    let result = 'pending';
    f.run(index).then(
      () => {
        result = 'resolved';
      },
      (error) => {
        result = error.message;
      }
    );
    await new Promise(setImmediate);
    f.advance(budget);
    context.mock.timers.tick(budget);
    await new Promise(setImmediate);
    assert.match(result, /FINANCIAL_CHECKPOINT_PERSISTENCE_TIMEOUT/);
    assert.throws(() => f.observer.observations(), /CLOSED/);
  });
}
