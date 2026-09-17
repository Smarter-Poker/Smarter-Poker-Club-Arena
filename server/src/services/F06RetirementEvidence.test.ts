import { expect, it } from 'vitest';
import { F06OriginalIntentSession } from './F06OriginalIntentSession.js';
import { F06HandPermit } from './F06HandPermit.js';
import {
  assertF06RetainedPermitBinding,
  decodeF06TerminalAdmissionReceipt,
  type RetainedRetirementBinding,
  type TerminalAdmissionExpectation,
} from './F06RetirementEvidence.js';
const id = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = {
  admission_id: id(1),
  tournament_id: id(2),
  table_id: id(3),
  lifecycle: '9007199254740993',
  lease_generation: id(4),
  custody_id: id(5),
};
function sessionFixture() {
  let current = true;
  let mode: ((name: string, input: Record<string, unknown>) => Promise<any>) | null = null;
  const calls: string[] = [];
  const session = new F06OriginalIntentSession(
    identity,
    async (name, input) => {
      calls.push(name);
      if (mode) return mode(name, input);
      if (name === 'fn_f06_resolve_engine_admission')
        return { data: { ok: true, ...identity, state: 'ACTIVE', revision: '7' }, error: null };
      if (name === 'fn_f06_allocate_original_intent')
        return {
          data: {
            ok: true,
            ...identity,
            state: 'INTENT',
            admission_revision: '7',
            permit_id: id(6),
            hand_number: '1000001',
          },
          error: null,
        };
      throw new Error('unexpected ' + name);
    },
    () => current,
    () => id(6)
  );
  return {
    session,
    calls,
    loseOwner: () => {
      current = false;
    },
    setMode: (f: typeof mode) => {
      mode = f;
    },
  };
}
async function evidenceFixture(retain = true) {
  const f = sessionFixture();
  await f.session.admit();
  if (retain) await f.session.allocate();
  f.session.fenceForRetirement();
  const original = await f.session.retainedRetirementBinding();
  const expected: TerminalAdmissionExpectation = {
    original,
    breakId: id(10),
    parkCustodyId: id(11),
    parkRevision: '12',
    cleanupKind: 'retired',
  };
  const value: any = {
    ok: true,
    ...identity,
    state: 'TERMINAL',
    revision: '9',
    origin_generation: identity.lease_generation,
    original_custody_id: identity.custody_id,
    retirement_break_id: id(10),
    retirement_custody_id: id(11),
    retirement_operation_revision: '12',
    terminal_receipt: {
      admission_id: identity.admission_id,
      tournament_id: identity.tournament_id,
      table_id: identity.table_id,
      lifecycle: identity.lifecycle,
      origin_generation: identity.lease_generation,
      original_custody_id: identity.custody_id,
      revision: '9',
      break_id: id(10),
      park_custody_id: id(11),
      park_revision: '12',
      cleanup_kind: 'retired',
      canonical_hands: retain
        ? [
            {
              permit_id: id(6),
              hand_number: '1000001',
              state: 'never_started',
              evidence_id: id(11),
            },
          ]
        : [],
    },
  };
  return { ...f, original, expected, value };
}
it('local retirement accessor requires latch and original owner and sends no RPC', async () => {
  const f = sessionFixture();
  await f.session.admit();
  await expect(f.session.retainedRetirementBinding()).rejects.toThrow(
    'f06_retirement_fence_required'
  );
  f.session.fenceForRetirement();
  const before = f.calls.length;
  const b = await f.session.retainedRetirementBinding();
  expect(b.intent.kind).toBe('not_retained');
  expect(b.admissionRevision).toBe('7');
  expect(b.admission).toEqual(identity);
  expect(f.calls).toHaveLength(before);
  expect(Object.isFrozen(b)).toBe(true);
  expect(Object.isFrozen(b.admission)).toBe(true);
  expect(Object.isFrozen(b.intent)).toBe(true);
  expect(f.session.canStart()).toBe(false);
  f.loseOwner();
  await expect(f.session.retainedRetirementBinding()).rejects.toThrow('f06_intent_owner_changed');
});
it('unknown admission revision remains unknown rather than being manufactured', async () => {
  const f = sessionFixture();
  f.session.fenceForRetirement();
  const b = await f.session.retainedRetirementBinding();
  expect(b.admissionRevision).toBeNull();
  expect(b.intent.kind).toBe('not_retained');
  expect(f.calls).toHaveLength(0);
});
it('lost allocation retains the exact unresolved permit without a synthetic binding', async () => {
  const f = sessionFixture();
  await f.session.admit();
  f.setMode(async () => ({ data: null, error: 'lost' }));
  await expect(f.session.allocate()).rejects.toThrow();
  f.session.fenceForRetirement();
  const b = await f.session.retainedRetirementBinding();
  expect(b.intent).toEqual({ kind: 'unresolved', permitId: id(6) });
  expect(f.calls.filter((n) => n === 'fn_f06_allocate_original_intent')).toHaveLength(1);
});
it('accessor waits behind pending allocation but does not convert its retired reply into a hand', async () => {
  const f = sessionFixture();
  await f.session.admit();
  let release!: (value: any) => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  f.setMode(async () => {
    entered();
    return new Promise((r) => (release = r));
  });
  const allocating = f.session.allocate();
  const rejection = expect(allocating).rejects.toThrow('f06_admission_not_active');
  await started;
  f.session.fenceForRetirement();
  let done = false;
  const read = f.session.retainedRetirementBinding().then((b) => {
    done = true;
    return b;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  release({
    data: {
      ok: true,
      ...identity,
      state: 'INTENT',
      admission_revision: '7',
      permit_id: id(6),
      hand_number: '1000001',
    },
    error: null,
  });
  await rejection;
  expect((await read).intent).toEqual({ kind: 'unresolved', permitId: id(6) });
});
it('BEGIN remains independent: accessor can return while raw BEGIN is still pending and grants no drain', async () => {
  const f = sessionFixture();
  await f.session.admit();
  const intent = await f.session.allocate();
  let release!: (v: any) => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  f.setMode(async () => {
    entered();
    return new Promise((r) => (release = r));
  });
  const input = Object.fromEntries(
    Object.entries(intent).map(([key, value]) => ['p_' + key, value])
  );
  const begin = f.session.begin(input);
  const rejection = expect(begin).rejects.toThrow('f06_original_begin_retired');
  await started;
  f.session.fenceForRetirement();
  const b = await f.session.retainedRetirementBinding();
  expect(b.intent.kind).toBe('retained');
  expect(f.session.canStart()).toBe(false);
  release({ data: { ok: true, state: 'reserved' }, error: null });
  await rejection;
});
it('retained binding matches actual permit identity while forHand remains start-only', async () => {
  const f = await evidenceFixture();
  if (f.original.intent.kind !== 'retained') throw new Error('fixture');
  const permit = new F06HandPermit(
    f.original.intent.binding,
    async () => ({ data: null, error: null }),
    () => true
  );
  expect(() => assertF06RetainedPermitBinding(f.original, permit.binding)).not.toThrow();
  expect(Object.isFrozen(f.original.intent.binding)).toBe(true);
  expect(() => f.session.forHand('1000001')).toThrow('f06_original_hand_unproven');
});
for (const key of [
  'tournament_id',
  'table_id',
  'lifecycle',
  'lease_generation',
  'custody_id',
  'permit_id',
  'hand_number',
] as const)
  it('retained permit comparison refuses changed ' + key, async () => {
    const f = await evidenceFixture();
    if (f.original.intent.kind !== 'retained') throw new Error('fixture');
    const b = {
      ...f.original.intent.binding,
      [key]: key === 'hand_number' ? '1000002' : key === 'lifecycle' ? '2' : id(99),
    };
    expect(() => assertF06RetainedPermitBinding(f.original, b)).toThrow(
      'f06_terminal_admission_unproven'
    );
  });
it('decoder binds exact terminal envelope and nested receipt with immutable output', async () => {
  const f = await evidenceFixture();
  const result = decodeF06TerminalAdmissionReceipt(f.value, f.expected);
  expect(result.admission).toEqual(identity);
  expect(result.revision).toBe('9');
  expect(result.canonicalHands).toEqual([
    { permitId: id(6), handNumber: '1000001', outcome: 'never_started', evidenceId: id(11) },
  ]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.canonicalHands)).toBe(true);
  expect(Object.isFrozen(result.canonicalHands[0])).toBe(true);
  f.value.terminal_receipt.canonical_hands[0].hand_number = '1000002';
  expect(result.canonicalHands[0].handNumber).toBe('1000001');
});
for (const key of [
  'ok',
  'state',
  'admission_id',
  'tournament_id',
  'table_id',
  'lifecycle',
  'lease_generation',
  'custody_id',
  'origin_generation',
  'original_custody_id',
  'revision',
  'retirement_break_id',
  'retirement_custody_id',
  'retirement_operation_revision',
])
  it('terminal envelope rejects changed ' + key, async () => {
    const f = await evidenceFixture();
    f.value[key] = 'changed';
    expect(() => decodeF06TerminalAdmissionReceipt(f.value, f.expected)).toThrow(
      'f06_terminal_admission_unproven'
    );
  });
for (const key of [
  'admission_id',
  'tournament_id',
  'table_id',
  'lifecycle',
  'origin_generation',
  'original_custody_id',
  'revision',
  'break_id',
  'park_custody_id',
  'park_revision',
  'cleanup_kind',
])
  it('nested terminal receipt rejects changed ' + key, async () => {
    const f = await evidenceFixture();
    f.value.terminal_receipt[key] = 'changed';
    expect(() => decodeF06TerminalAdmissionReceipt(f.value, f.expected)).toThrow(
      'f06_terminal_admission_unproven'
    );
  });
for (const mutation of [
  'missing',
  'duplicate-permit',
  'duplicate-hand',
  'descending',
  'unsupported',
  'wrong-no-start-evidence',
  'unsafe',
  'leading-zero',
  'numeric',
  'wrong-retained-hand',
  'missing-evidence',
])
  it('canonical outcome rejects ' + mutation, async () => {
    const f = await evidenceFixture();
    const list = f.value.terminal_receipt.canonical_hands;
    const hand = list[0];
    if (mutation === 'missing') list.length = 0;
    if (mutation === 'duplicate-permit') list.push({ ...hand, hand_number: '1000002' });
    if (mutation === 'duplicate-hand') list.push({ ...hand, permit_id: id(7) });
    if (mutation === 'descending')
      list.unshift({ ...hand, permit_id: id(7), hand_number: '1000002' });
    if (mutation === 'unsupported') hand.state = 'reserved';
    if (mutation === 'wrong-no-start-evidence') hand.evidence_id = id(99);
    if (mutation === 'unsafe') hand.hand_number = '9007199254740992';
    if (mutation === 'leading-zero') hand.hand_number = '01000001';
    if (mutation === 'numeric') hand.hand_number = 1000001;
    if (mutation === 'wrong-retained-hand') hand.hand_number = '1000002';
    if (mutation === 'missing-evidence') delete hand.evidence_id;
    expect(() => decodeF06TerminalAdmissionReceipt(f.value, f.expected)).toThrow(
      'f06_terminal_admission_unproven'
    );
  });
it('accepted hand evidence is retained distinctly from no-start park custody', async () => {
  const f = await evidenceFixture();
  f.value.terminal_receipt.canonical_hands[0].state = 'accepted';
  f.value.terminal_receipt.canonical_hands[0].evidence_id = id(20);
  expect(decodeF06TerminalAdmissionReceipt(f.value, f.expected).canonicalHands[0].evidenceId).toBe(
    id(20)
  );
});
it('empty canonical hands can decode only as matching shape, never inferred local absence', async () => {
  const f = await evidenceFixture(false);
  expect(decodeF06TerminalAdmissionReceipt(f.value, f.expected).canonicalHands).toEqual([]);
  expect(f.original.intent.kind).toBe('not_retained');
  expect(f.calls).toEqual(['fn_f06_resolve_engine_admission']);
});
it('unresolved original UUID must occur in the canonical receipt', async () => {
  const f = await evidenceFixture();
  const original: RetainedRetirementBinding = {
    ...f.original,
    intent: { kind: 'unresolved', permitId: id(6) },
  };
  expect(() =>
    decodeF06TerminalAdmissionReceipt(f.value, { ...f.expected, original })
  ).not.toThrow();
  expect(() =>
    decodeF06TerminalAdmissionReceipt(f.value, {
      ...f.expected,
      original: { ...original, intent: { kind: 'unresolved', permitId: id(99) } },
    })
  ).toThrow();
});
it('unknown historical admission revision cannot be guessed from a terminal response', async () => {
  const f = await evidenceFixture();
  expect(() =>
    decodeF06TerminalAdmissionReceipt(f.value, {
      ...f.expected,
      original: { ...f.original, admissionRevision: null },
    })
  ).toThrow();
});
it('missing original identity fields cannot be supplied by the terminal envelope', async () => {
  const f = await evidenceFixture();
  const admission: any = { ...identity };
  delete admission.custody_id;
  expect(() =>
    decodeF06TerminalAdmissionReceipt(f.value, {
      ...f.expected,
      original: { ...f.original, admission },
    })
  ).toThrow();
});
