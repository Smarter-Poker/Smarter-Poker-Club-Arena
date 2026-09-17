import {
  decodeF06OriginalDisposition,
  decodeF06TerminalDisposition,
} from './F06DispositionConsumer.js';
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
function absentFixture() {
  const f = fixture();
  f.expected.original.intent = { kind: 'unresolved', permitId: id(6) };
  f.expected.writers.writers = f.expected.writers.writers.slice(0, 2);
  f.expected.writers.writers[1].state = 'unknown';
  f.expected.writers.lastAttempt = 2;
  f.receipt.canonical_hands = [];
  f.receipt.intent_count = 0;
  const absence: any = {
    contract_version: 1,
    kind: 'original_allocation_absence',
    binding: { ...f.receipt.binding },
    attempt: {
      rpc: 'fn_f06_allocate_original_intent',
      permit_id: id(6),
      admission_revision: '1',
      hand_number: null,
    },
    disposition: 'no_original_intent_committed_and_future_allocation_excluded',
    authority: 'canonical_database_allocation_exclusion_only',
  };
  return { ...f, absence };
}
function terminal(pre: any) {
  const a = pre.original;
  return {
    ...a,
    ok: true,
    state: 'TERMINAL',
    revision: '3',
    origin_generation: a.lease_generation,
    original_custody_id: a.custody_id,
    retirement_break_id: pre.breakId,
    retirement_custody_id: pre.parkCustodyId,
    retirement_operation_revision: pre.parkRevision,
    terminal_receipt: {
      admission_id: a.admission_id,
      table_id: a.table_id,
      tournament_id: a.tournament_id,
      lifecycle: a.lifecycle,
      origin_generation: a.lease_generation,
      original_custody_id: a.custody_id,
      revision: '3',
      break_id: pre.breakId,
      park_custody_id: pre.parkCustodyId,
      park_revision: pre.parkRevision,
      cleanup_kind: 'retired',
      canonical_hands: pre.canonicalHands.map((h: any) => ({
        permit_id: h.permitId,
        hand_number: h.handNumber,
        state: h.outcome,
        evidence_id: h.evidenceId,
      })),
    },
  };
}
test('admission, allocator and BEGIN have separate typed matching cases', () => {
  const f = fixture(),
    pre = decodeF06OriginalDisposition(f.receipt, [], f.expected);
  assert.deepEqual(
    pre.attempts.map((a) => [a.kind, a.disposition.kind]),
    [
      ['admission', 'admission_registration'],
      ['allocator', 'canonical_hand'],
      ['begin', 'canonical_hand'],
      ['begin', 'canonical_hand'],
    ]
  );
  assert.equal(pre.attempts[2].observedState, 'unknown');
  assert.equal(pre.authority, 'none');
});
test('explicit allocator absence matches only allocator and survives terminal empty canonical list', () => {
  const f = absentFixture(),
    before = structuredClone(f);
  const pre = decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected);
  assert.equal(pre.attempts[1].disposition.kind, 'allocator_absence');
  assert.equal(pre.attempts[1].observedState, 'unknown');
  const result = decodeF06TerminalDisposition(terminal(pre), pre, 'retired');
  assert.equal(result.allocatorAbsences, pre.allocatorAbsences);
  assert.equal(result.preCleanup, pre);
  assert.equal(result.terminal.canonicalHands.length, 0);
  assert.equal(result.authority, 'none');
  assert.deepEqual(f, before);
  assert(
    Object.isFrozen(pre) &&
      Object.isFrozen(pre.attempts) &&
      pre.attempts.every(Object.isFrozen) &&
      Object.isFrozen(pre.allocatorAbsences[0].binding) &&
      Object.isFrozen(result)
  );
});
test('strict0014 still refuses the same missing UUID', () => {
  const f = absentFixture();
  assert.throws(() => decodeF06AllIntentDisposition(f.receipt, f.expected));
});
test('empty canonical list without explicit absence remains unknown', () => {
  const f = absentFixture();
  assert.throws(() => decodeF06OriginalDisposition(f.receipt, [], f.expected));
});
test('BEGIN for an absent UUID contradicts absence even with coherent lastAttempt', () => {
  const f = absentFixture();
  f.expected.writers.writers.push({ ...fixture().expected.writers.writers[2] });
  f.expected.writers.lastAttempt = 3;
  assert.throws(() => decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected));
});
test('known retained hand contradicts absence', () => {
  const f = absentFixture();
  f.expected.original.intent = fixture().expected.original.intent;
  assert.throws(() => decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected));
});
test('canonical hand plus absence for one UUID is contradictory', () => {
  const f = absentFixture();
  f.receipt.canonical_hands = fixture().receipt.canonical_hands;
  f.receipt.intent_count = 1;
  assert.throws(() => decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected));
});
test('duplicate absence receipt is rejected', () => {
  const f = absentFixture();
  assert.throws(() =>
    decodeF06OriginalDisposition(f.receipt, [f.absence, structuredClone(f.absence)], f.expected)
  );
});
test('same UUID repeated allocator attempts keep separate ordinals', () => {
  const f = absentFixture();
  f.expected.writers.writers.push({ ...f.expected.writers.writers[1], attempt: 3 });
  f.expected.writers.lastAttempt = 3;
  const pre = decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected);
  assert.deepEqual(
    pre.attempts.map((a) => a.attempt),
    [1, 2, 3]
  );
  assert.equal(pre.attempts[1].disposition, pre.attempts[2].disposition);
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
  test('absence rejects changed ' + key, () => {
    const f = absentFixture();
    f.absence.binding[key] = 'wrong';
    assert.throws(() => decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected));
  });
}
for (const [key, v] of [
  ['rpc', 'fn_f06_begin_hand_with_intent'],
  ['permit_id', id(99)],
  ['admission_revision', '2'],
  ['hand_number', '1000001'],
]) {
  test('absence rejects attempt ' + key, () => {
    const f = absentFixture();
    f.absence.attempt[key as string] = v;
    assert.throws(() => decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected));
  });
}
for (const [key, v] of [
  ['kind', 'never_started'],
  ['contract_version', '1'],
  ['authority', 'permission'],
  ['disposition', 'absent'],
]) {
  test('absence rejects envelope ' + key, () => {
    const f = absentFixture();
    f.absence[key as string] = v;
    assert.throws(() => decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected));
  });
}
test('pending raw allocator refuses despite a supplied receipt', () => {
  const f = absentFixture();
  f.expected.writers.writers[1].state = 'pending';
  assert.throws(() => decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected));
});
test('missing original revision is never inferred from absence', () => {
  const f = absentFixture();
  f.expected.original.admissionRevision = null;
  assert.throws(() => decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected));
});
test('absence without any captured allocator is rejected', () => {
  const f = absentFixture();
  f.expected.writers.writers.pop();
  f.expected.writers.lastAttempt = 1;
  assert.throws(() => decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected));
});
test('omitted ordinal refuses', () => {
  const f = absentFixture();
  f.expected.writers.writers.pop();
  assert.throws(() => decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected));
});
test('terminal cannot consume cloned pre-cleanup evidence', () => {
  const f = absentFixture(),
    pre = decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected);
  assert.throws(() => decodeF06TerminalDisposition(terminal(pre), structuredClone(pre), 'retired'));
});
for (const key of [
  'admission_id',
  'table_id',
  'tournament_id',
  'lifecycle',
  'origin_generation',
  'original_custody_id',
  'revision',
  'break_id',
  'park_custody_id',
  'park_revision',
  'cleanup_kind',
]) {
  test('terminal rejects nested ' + key, () => {
    const f = absentFixture(),
      pre = decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected),
      r = terminal(pre);
    (r.terminal_receipt as any)[key] = 'wrong';
    assert.throws(() => decodeF06TerminalDisposition(r, pre, 'retired'));
  });
}
test('terminal must exactly preserve pre-cleanup canonical hand outcomes', () => {
  const f = fixture(),
    pre = decodeF06OriginalDisposition(f.receipt, [], f.expected),
    r = terminal(pre);
  r.terminal_receipt.canonical_hands[0].evidence_id = id(99);
  assert.throws(() => decodeF06TerminalDisposition(r, pre, 'retired'));
});
test('terminal cannot fabricate canonical hand for absent UUID', () => {
  const f = absentFixture(),
    pre = decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected),
    r = terminal(pre);
  r.terminal_receipt.canonical_hands = fixture().receipt.canonical_hands;
  assert.throws(() => decodeF06TerminalDisposition(r, pre, 'retired'));
});
test('terminal outer original identity remains mandatory', () => {
  const f = absentFixture(),
    pre = decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected),
    r = terminal(pre);
  r.custody_id = id(99);
  assert.throws(() => decodeF06TerminalDisposition(r, pre, 'retired'));
});

function mixedFixture() {
  const f = fixture();
  f.expected.original.intent = { kind: 'unresolved', permitId: id(77) };
  f.expected.writers.writers.push({
    kind: 'allocator',
    rpc: 'fn_f06_allocate_original_intent',
    operationId: id(77),
    attempt: 5,
    admissionRevision: '1',
    handNumber: null,
    state: 'unknown',
  });
  f.expected.writers.lastAttempt = 5;
  const absence = {
    contract_version: 1,
    kind: 'original_allocation_absence',
    binding: { ...f.receipt.binding },
    attempt: {
      rpc: 'fn_f06_allocate_original_intent',
      permit_id: id(77),
      admission_revision: '1',
      hand_number: null,
    },
    disposition: 'no_original_intent_committed_and_future_allocation_excluded',
    authority: 'canonical_database_allocation_exclusion_only',
  };
  return { ...f, absence };
}
test('mixed canonical BEGIN and distinct allocator absence retain both evidence types after ACK', () => {
  const f = mixedFixture(),
    pre = decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected);
  assert.deepEqual(
    pre.attempts.map((a) => a.disposition.kind),
    [
      'admission_registration',
      'canonical_hand',
      'canonical_hand',
      'canonical_hand',
      'allocator_absence',
    ]
  );
  const result = decodeF06TerminalDisposition(terminal(pre), pre, 'retired');
  assert.equal(result.terminal.canonicalHands.length, 1);
  assert.equal(result.terminal.canonicalHands[0].permitId, id(6));
  assert.equal(result.allocatorAbsences[0].permitId, id(77));
  assert.equal(result.allocatorAbsences, pre.allocatorAbsences);
});
test('mixed same-UUID allocator retries preserve each ordinal without adding a terminal hand', () => {
  const f = mixedFixture();
  f.expected.writers.writers.push({ ...f.expected.writers.writers[4], attempt: 6 });
  f.expected.writers.lastAttempt = 6;
  const pre = decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected);
  assert.deepEqual(
    pre.attempts.slice(4).map((a) => a.attempt),
    [5, 6]
  );
  assert.equal(pre.attempts[4].disposition, pre.attempts[5].disposition);
  assert.equal(
    decodeF06TerminalDisposition(terminal(pre), pre, 'retired').terminal.canonicalHands.length,
    1
  );
});
test('adding BEGIN for the absent UUID contradicts the mixed evidence set', () => {
  const f = mixedFixture();
  f.expected.writers.writers.push({
    ...f.expected.writers.writers[2],
    operationId: id(77),
    attempt: 6,
  });
  f.expected.writers.lastAttempt = 6;
  assert.throws(() => decodeF06OriginalDisposition(f.receipt, [f.absence], f.expected));
});
