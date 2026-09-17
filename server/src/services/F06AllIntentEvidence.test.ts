import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  decodeF06AllIntentDisposition,
  F06_ALL_INTENT_WIRE_DEPENDENCY,
} from './F06AllIntentEvidence.js';
import { F06OriginalIntentSession } from './F06OriginalIntentSession.js';
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
function fixture() {
  const a = {
    admission_id: id(1),
    tournament_id: id(2),
    table_id: id(3),
    lifecycle: '1',
    lease_generation: id(4),
    custody_id: id(5),
  };
  const original: any = {
    admission: a,
    admissionRevision: '1',
    intent: {
      kind: 'retained',
      binding: { ...a, admission_revision: '1', permit_id: id(6), hand_number: '1000001' },
    },
  };
  const writers: any = {
    admissionId: id(1),
    admissionRevision: '1',
    originalGeneration: id(4),
    coverage: 'captured-before-first-writer',
    lastAttempt: 4,
    writers: [
      {
        kind: 'admission',
        rpc: 'fn_f06_register_engine_admission',
        operationId: id(1),
        attempt: 1,
        admissionRevision: null,
        handNumber: null,
        state: 'unknown',
      },
      {
        kind: 'allocator',
        rpc: 'fn_f06_allocate_original_intent',
        operationId: id(6),
        attempt: 2,
        admissionRevision: '1',
        handNumber: null,
        state: 'returned',
      },
      {
        kind: 'begin',
        rpc: 'fn_f06_begin_hand_with_intent',
        operationId: id(6),
        attempt: 3,
        admissionRevision: '1',
        handNumber: '1000001',
        state: 'unknown',
      },
      {
        kind: 'begin',
        rpc: 'fn_f06_begin_hand_with_intent',
        operationId: id(6),
        attempt: 4,
        admissionRevision: '1',
        handNumber: '1000001',
        state: 'returned',
      },
    ],
  };
  const expected: any = {
    original,
    writers,
    breakId: id(7),
    parkCustodyId: id(8),
    parkRevision: '2',
  };
  const receipt: any = {
    contract_version: 1,
    kind: 'original_all_intent_disposition',
    binding: {
      admission_id: id(1),
      original_admission_revision: '1',
      retiring_admission_revision: '2',
      tournament_id: id(2),
      table_id: id(3),
      lifecycle: '1',
      origin_generation: id(4),
      original_custody_id: id(5),
      break_id: id(7),
      park_custody_id: id(8),
      park_revision: '2',
    },
    canonical_hands: [
      {
        permit_id: id(6),
        hand_number: '1000001',
        original_admission_revision: '1',
        state: 'never_started',
        evidence_id: id(8),
      },
    ],
    intent_count: 1,
    new_original_intents_excluded: true,
    authority: 'canonical_database_disposition_only',
  };
  return { a, expected, receipt };
}
test('matches every distinct retained attempt without changing unknowns or granting authority', () => {
  const f = fixture(),
    before = structuredClone(f);
  const result = decodeF06AllIntentDisposition(f.receipt, f.expected);
  assert.equal(result.matchedAttempts.length, 4);
  assert.deepEqual(
    result.matchedAttempts.map((a) => a.attempt),
    [1, 2, 3, 4]
  );
  assert.equal(result.matchedAttempts[2].observedState, 'unknown');
  assert.equal(result.authority, 'none');
  assert.equal(result.dependencyStatus, 'unaccepted');
  assert.equal(F06_ALL_INTENT_WIRE_DEPENDENCY.status, 'unaccepted');
  assert.deepEqual(f, before);
  assert(
    Object.isFrozen(result) &&
      Object.isFrozen(result.original) &&
      Object.isFrozen(result.canonicalHands) &&
      result.canonicalHands.every(Object.isFrozen) &&
      Object.isFrozen(result.matchedAttempts) &&
      result.matchedAttempts.every(Object.isFrozen)
  );
});
for (const key of [
  'admission_id',
  'original_admission_revision',
  'retiring_admission_revision',
  'tournament_id',
  'table_id',
  'lifecycle',
  'origin_generation',
  'original_custody_id',
  'break_id',
  'park_custody_id',
  'park_revision',
]) {
  test('rejects changed binding ' + key, () => {
    const f = fixture();
    f.receipt.binding[key] = 'wrong';
    assert.throws(() => decodeF06AllIntentDisposition(f.receipt, f.expected));
  });
}
for (const [key, value] of [
  ['contract_version', '1'],
  ['kind', 'terminal'],
  ['authority', 'local-drain'],
  ['new_original_intents_excluded', false],
  ['intent_count', '1'],
  ['intent_count', 2],
  ['canonical_hands', null],
]) {
  test('rejects envelope ' + key + ' ' + value, () => {
    const f = fixture();
    f.receipt[key as string] = value;
    assert.throws(() => decodeF06AllIntentDisposition(f.receipt, f.expected));
  });
}
for (const [key, value] of [
  ['permit_id', id(90)],
  ['hand_number', '1000002'],
  ['hand_number', '01000001'],
  ['hand_number', 1000001],
  ['hand_number', '9007199254740992'],
  ['original_admission_revision', '2'],
  ['state', 'reserved'],
  ['evidence_id', id(90)],
  ['evidence_id', null],
]) {
  test('rejects canonical hand ' + key + ' ' + value, () => {
    const f = fixture();
    f.receipt.canonical_hands[0][key as string] = value;
    assert.throws(() => decodeF06AllIntentDisposition(f.receipt, f.expected));
  });
}
for (const [key, value] of [
  ['admissionId', id(90)],
  ['admissionRevision', null],
  ['admissionRevision', '2'],
  ['originalGeneration', id(90)],
  ['coverage', 'incomplete'],
]) {
  test('rejects observation ' + key, () => {
    const f = fixture();
    f.expected.writers[key as string] = value;
    assert.throws(() => decodeF06AllIntentDisposition(f.receipt, f.expected));
  });
}
for (const [key, value] of [
  ['attempt', 2],
  ['attempt', 3.5],
  ['kind', 'dispatch'],
  ['rpc', 'fn_f06_begin_hand'],
  ['operationId', id(90)],
  ['state', 'pending'],
  ['state', 'done'],
  ['admissionRevision', '2'],
  ['handNumber', '1000002'],
  ['handNumber', null],
]) {
  test('rejects BEGIN attempt ' + key + ' ' + value, () => {
    const f = fixture();
    f.expected.writers.writers[2][key as string] = value;
    assert.throws(() => decodeF06AllIntentDisposition(f.receipt, f.expected));
  });
}
test('rejects an omitted middle attempt rather than silently renumbering', () => {
  const f = fixture();
  f.expected.writers.writers.splice(1, 1);
  assert.throws(() => decodeF06AllIntentDisposition(f.receipt, f.expected));
});
test('unknown original revision cannot be inferred from proof', () => {
  const f = fixture();
  f.expected.original.admissionRevision = null;
  assert.throws(() => decodeF06AllIntentDisposition(f.receipt, f.expected));
});
test('overflowing original revision is refused', () => {
  const f = fixture();
  f.expected.original.admissionRevision = '9223372036854775807';
  assert.throws(() => decodeF06AllIntentDisposition(f.receipt, f.expected));
});
test('duplicates are refused even with adjusted count', () => {
  const f = fixture();
  f.receipt.canonical_hands.push({ ...f.receipt.canonical_hands[0] });
  f.receipt.intent_count = 2;
  assert.throws(() => decodeF06AllIntentDisposition(f.receipt, f.expected));
});
test('accepted outcome accepts canonical evidence UUID distinct from park', () => {
  const f = fixture();
  f.receipt.canonical_hands[0].state = 'accepted';
  f.receipt.canonical_hands[0].evidence_id = id(90);
  assert.equal(
    decodeF06AllIntentDisposition(f.receipt, f.expected).canonicalHands[0].outcome,
    'accepted'
  );
});
test('zero proposed intents is matching evidence only with no retained permit/writer UUIDs', () => {
  const f = fixture();
  f.expected.original.intent = { kind: 'not_retained' };
  f.expected.writers.writers = f.expected.writers.writers.slice(0, 1);
  f.expected.writers.lastAttempt = 1;
  f.receipt.canonical_hands = [];
  f.receipt.intent_count = 0;
  const result = decodeF06AllIntentDisposition(f.receipt, f.expected);
  assert.equal(result.canonicalHands.length, 0);
  assert.equal(result.authority, 'none');
});
test('missing unresolved allocation UUID is not positive absence', () => {
  const f = fixture();
  f.expected.original.intent = { kind: 'unresolved', permitId: id(90) };
  assert.throws(() => decodeF06AllIntentDisposition(f.receipt, f.expected));
});
test('every earlier BEGIN keeps its original hand binding after a later intent', () => {
  const f = fixture();
  f.receipt.canonical_hands.push({
    ...f.receipt.canonical_hands[0],
    permit_id: id(9),
    hand_number: '1000002',
  });
  f.receipt.intent_count = 2;
  f.expected.original.intent.binding.permit_id = id(9);
  f.expected.original.intent.binding.hand_number = '1000002';
  const result = decodeF06AllIntentDisposition(f.receipt, f.expected);
  assert.equal(result.matchedAttempts[2].canonicalHand?.handNumber, '1000001');
  f.receipt.canonical_hands[0].hand_number = '1000000';
  assert.throws(() => decodeF06AllIntentDisposition(f.receipt, f.expected));
});
test('real Session retains BEGIN input revision and hand across concurrent attempts', async () => {
  const f = fixture();
  let registered = false;
  const rpc = async (name: string, input: any) => {
    if (name === 'fn_f06_resolve_engine_admission')
      return {
        data: {
          ...f.a,
          ok: true,
          state: registered ? 'ACTIVE' : 'ELIGIBLE',
          revision: '1',
          protocol_epoch: '1',
          enrollment_token: 'a'.repeat(64),
        },
        error: null,
      };
    if (name === 'fn_f06_register_engine_admission') {
      registered = true;
      return { data: { ...f.a, ok: true, state: 'ACTIVE', revision: '1' }, error: null };
    }
    if (name === 'fn_f06_allocate_original_intent')
      return {
        data: {
          ...f.a,
          ok: true,
          state: 'INTENT',
          admission_revision: '1',
          permit_id: input.p_permit_id,
          hand_number: '1000001',
        },
        error: null,
      };
    return { data: null, error: 'lost' };
  };
  const session = new F06OriginalIntentSession(
    f.a,
    rpc,
    () => true,
    () => id(6)
  );
  await session.admit();
  await session.allocate();
  const input = Object.fromEntries(
    Object.entries(session.forHand('1000001')).map(([k, v]) => ['p_' + k, v])
  );
  await Promise.all([assert.rejects(session.begin(input)), assert.rejects(session.begin(input))]);
  session.fenceForRetirement();
  const writers = await session.inspectOriginalWriters();
  const original = await session.retainedRetirementBinding();
  const result = decodeF06AllIntentDisposition(f.receipt, { ...f.expected, original, writers });
  assert.deepEqual(
    result.matchedAttempts
      .filter((a) => a.kind === 'begin')
      .map((a) => [a.attempt, a.observedState, a.canonicalHand?.handNumber]),
    [
      [3, 'unknown', '1000001'],
      [4, 'unknown', '1000001'],
    ]
  );
  assert.deepEqual(
    (await session.inspectOriginalWriters()).writers.map((w) => w.state),
    ['returned', 'returned', 'unknown', 'unknown']
  );
});

test('omitted final attempt is refused against captured lastAttempt', () => {
  const f = fixture();
  f.expected.writers.writers.pop();
  assert.throws(() => decodeF06AllIntentDisposition(f.receipt, f.expected));
});
