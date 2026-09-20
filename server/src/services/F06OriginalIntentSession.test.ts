import { test } from 'vitest';
import assert from 'node:assert/strict';
import { F06OriginalIntentSession } from './F06OriginalIntentSession.js';
import { F06HandPermit } from './F06HandPermit.js';
// Current imported classes; RPC replies are controlled protocol boundaries.
const id = (n: any) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
function fixture() {
  const identity = {
    admission_id: id(1),
    tournament_id: id(2),
    table_id: id(3),
    lifecycle: '1',
    lease_generation: id(4),
    custody_id: id(5),
  };
  let owner = true,
    admitted = false,
    next = 10,
    intent = null as any,
    loseAdmission = false,
    loseAllocation = false,
    mode = null as any;
  const calls: any[] = [];
  const rpc = async (name: any, input: any) => {
    calls.push([name, { ...input }]);
    if (mode) return mode(name, input);
    if (name === 'fn_f06_resolve_engine_admission')
      return {
        data: {
          ok: true,
          ...identity,
          state: admitted ? 'ACTIVE' : 'ELIGIBLE',
          revision: '1',
          protocol_epoch: '1',
          enrollment_token: 'a'.repeat(64),
        },
        error: null,
      };
    if (name === 'fn_f06_register_engine_admission') {
      admitted = true;
      if (loseAdmission) {
        loseAdmission = false;
        return { data: null, error: 'lost' };
      }
      return { data: { ok: true, ...identity, state: 'ACTIVE', revision: '1' }, error: null };
    }
    if (name === 'fn_f06_resolve_original_intent') return { data: intent, error: null };
    if (name === 'fn_f06_allocate_original_intent') {
      intent = {
        ok: true,
        ...identity,
        state: 'INTENT',
        permit_id: input.p_permit_id,
        hand_number: '1000001',
        admission_revision: '1',
      };
      if (loseAllocation) {
        loseAllocation = false;
        return { data: null, error: 'lost' };
      }
      return { data: intent, error: null };
    }
    throw Error(name);
  };
  const session = new F06OriginalIntentSession(
    identity,
    rpc,
    () => owner,
    () => id(next++)
  );
  return {
    session,
    calls,
    identity,
    setOwner: (v: any) => (owner = v),
    loseAdmission: () => (loseAdmission = true),
    loseAllocation: () => (loseAllocation = true),
    setMode: (f: any) => (mode = f),
    setIntent: (f: any) => (intent = f),
    allocation: () => intent,
  };
}
test('positive admission precedes one original allocation', async () => {
  const f = fixture();
  await f.session.admit();
  const i = await f.session.allocate();
  assert.equal(i.permit_id, id(10));
  assert.equal(f.session.forHand('1000001').permit_id, id(10));
  assert(f.session.canStart());
});
test('lost admission ACK resolves original UUID without a second registration', async () => {
  const f = fixture();
  f.loseAdmission();
  await assert.rejects(f.session.admit());
  await f.session.admit();
  assert.equal(f.calls.filter((c: any) => c[0] === 'fn_f06_register_engine_admission').length, 1);
  assert(f.calls.every((c: any) => c[1].p_admission_id === id(1)));
});
test('missing admission is unknown and never a creation grant', async () => {
  const f = fixture();
  f.setMode(async () => ({ data: null, error: null }));
  await assert.rejects(f.session.admit());
  assert.equal(f.calls.length, 1);
  assert(!f.session.canStart());
});
test('different original owner identity refuses', async () => {
  const f = fixture();
  f.setMode(async () => ({
    data: { ok: true, ...f.identity, admission_id: id(99), state: 'ACTIVE', revision: '1' },
    error: null,
  }));
  await assert.rejects(f.session.admit());
  assert(!f.session.canStart());
});
test('lost allocation ACK keeps exact permit UUID', async () => {
  const f = fixture();
  await f.session.admit();
  f.loseAllocation();
  await assert.rejects(f.session.allocate());
  const i = await f.session.allocate();
  assert.equal(i.permit_id, id(10));
  const ids = f.calls
    .filter((c: any) => c[0] === 'fn_f06_allocate_original_intent')
    .map((c: any) => c[1].p_permit_id);
  assert.deepEqual(ids, [id(10), id(10)]);
});
test('missing uncertain intent never replaces UUID', async () => {
  const f = fixture();
  await f.session.admit();
  f.loseAllocation();
  await assert.rejects(f.session.allocate());
  f.setIntent(null);
  await assert.rejects(f.session.allocate());
  assert.equal(f.calls.filter((c: any) => c[0] === 'fn_f06_allocate_original_intent').length, 1);
});
test('owner loss after RPC refuses publication', async () => {
  const f = fixture();
  f.setMode(async () => {
    f.setOwner(false);
    return { data: { ok: true, ...f.identity, state: 'ACTIVE', revision: '1' }, error: null };
  });
  await assert.rejects(f.session.admit());
  assert(!f.session.canStart());
});
test('retirement latches and prevents new allocation/start', async () => {
  const f = fixture();
  await f.session.admit();
  f.session.fenceForRetirement();
  await assert.rejects(f.session.allocate());
  await assert.rejects(f.session.admit());
  assert(!f.session.canStart());
});
test('bound prior intent cannot allocate a successor', async () => {
  const f = fixture();
  await f.session.admit();
  await f.session.allocate();
  f.setIntent({ ...f.allocation(), state: 'BOUND' });
  await assert.rejects(f.session.allocate());
  assert.equal(f.calls.filter((c: any) => c[0] === 'fn_f06_allocate_original_intent').length, 1);
});
test('unproved terminal cannot allocate a successor', async () => {
  const f = fixture();
  await f.session.admit();
  await f.session.allocate();
  f.setIntent({ ...f.allocation(), state: 'TERMINAL', canonical_terminal_verified: false });
  await assert.rejects(f.session.allocate());
});
test('retirement during allocation reply cannot publish intent', async () => {
  const f = fixture();
  await f.session.admit();
  f.setMode(async () => {
    f.session.fenceForRetirement();
    return {
      data: {
        ok: true,
        ...f.identity,
        state: 'INTENT',
        permit_id: id(10),
        admission_revision: '1',
        hand_number: '1000001',
      },
      error: null,
    };
  });
  await assert.rejects(f.session.allocate());
  assert(!f.session.canStart());
});
test('new-start latch does not suppress original no-start drain', async () => {
  const f = fixture();
  const binding = { ...f.identity, permit_id: id(10), hand_number: '1000001' };
  const permit = new F06HandPermit(
    binding,
    async () => ({
      data: { ...binding, generation: binding.lease_generation, ok: true, state: 'reserved' },
      error: null,
    }),
    () => true,
    () => false
  );
  await permit.reserve();
  let started = 0;
  assert.throws(() => permit.start(() => started++));
  assert.equal(started, 0);
  let stopped = 0;
  await permit.drainNeverStarted(
    async () => {
      stopped++;
    },
    () => true
  );
  assert.equal(stopped, 1);
});
for (const state of ['INTENT', 'TERMINAL'])
  test(
    'retained original hand refuses contradictory ' + state + ' resolver before allocation',
    async () => {
      const f = fixture();
      await f.session.admit();
      await f.session.allocate();
      f.setIntent({
        ...f.allocation(),
        state,
        hand_number: '1000002',
        canonical_terminal_verified: true,
      });
      await assert.rejects(f.session.allocate(), /f06_original_hand_changed/);
      assert.equal(
        f.calls.filter((c: any) => c[0] === 'fn_f06_allocate_original_intent').length,
        1
      );
      assert.equal(f.session.forHand('1000001').hand_number, '1000001');
    }
  );
test('allocator cannot overwrite hand already learned from matching intent resolver', async () => {
  const f = fixture();
  await f.session.admit();
  await f.session.allocate();
  const original = { ...f.allocation() };
  f.setMode(async (n: any) => ({
    data:
      n === 'fn_f06_resolve_original_intent' ? original : { ...original, hand_number: '1000002' },
    error: null,
  }));
  await assert.rejects(f.session.allocate(), /f06_original_hand_changed/);
  assert.equal(f.session.forHand('1000001').hand_number, '1000001');
});
test('lost allocation response recovers binding before rejecting a contradictory replay', async () => {
  const f = fixture();
  await f.session.admit();
  f.loseAllocation();
  await assert.rejects(f.session.allocate());
  const original = { ...f.allocation() };
  f.setMode(async (n: any) => ({
    data:
      n === 'fn_f06_resolve_original_intent' ? original : { ...original, hand_number: '1000002' },
    error: null,
  }));
  await assert.rejects(f.session.allocate(), /f06_original_hand_changed/);
  assert.equal(f.session.forHand('1000001').hand_number, '1000001');
});
for (const hand of [null, '0', '0999999', '1000000.0', '9007199254740992'])
  test('recovered original hand must be canonical and safe ' + String(hand), async () => {
    const f = fixture();
    await f.session.admit();
    f.loseAllocation();
    await assert.rejects(f.session.allocate());
    f.setIntent({ ...f.allocation(), hand_number: hand });
    await assert.rejects(f.session.allocate(), /f06_original_hand_unproven/);
    assert.equal(f.calls.filter((c: any) => c[0] === 'fn_f06_allocate_original_intent').length, 1);
  });
for (const state of ['INTENT', 'TERMINAL'])
  test(
    'retirement during ' + state + ' resolver prevents successor allocation dispatch',
    async () => {
      const f = fixture();
      await f.session.admit();
      await f.session.allocate();
      const original = { ...f.allocation(), state, canonical_terminal_verified: true };
      f.setMode(async () => {
        f.session.fenceForRetirement();
        return { data: original, error: null };
      });
      await assert.rejects(f.session.allocate());
      assert.equal(
        f.calls.filter((c: any) => c[0] === 'fn_f06_allocate_original_intent').length,
        1
      );
    }
  );
test('retirement during eligibility read prevents registration dispatch', async () => {
  const f = fixture();
  f.setMode(async () => {
    f.session.fenceForRetirement();
    return {
      data: {
        ok: true,
        ...f.identity,
        state: 'ELIGIBLE',
        protocol_epoch: '1',
        enrollment_token: 'a'.repeat(64),
      },
      error: null,
    };
  });
  await assert.rejects(f.session.admit());
  assert.equal(f.calls.length, 1);
});
test('exact canonical terminal binding permits a distinct successor UUID', async () => {
  const f = fixture();
  await f.session.admit();
  await f.session.allocate();
  f.setIntent({
    ...f.allocation(),
    state: 'TERMINAL',
    terminal_permit_id: id(10),
    canonical_terminal_verified: true,
  });
  const next = await f.session.allocate();
  assert.equal(next.permit_id, id(11));
});
test('BEGIN rejects explicit substituted admission ID before transport', async () => {
  const f = fixture();
  await f.session.admit();
  const intent = await f.session.allocate();
  const before = f.calls.length;
  const input = Object.fromEntries(Object.entries(intent).map(([k, v]: any) => ['p_' + k, v]));
  input.p_admission_id = id(999);
  await assert.rejects(f.session.begin(input), /f06_original_begin_changed/);
  assert.equal(f.calls.length, before);
});
test('Accounting enrollment token is exact SHA256 hex, not a guessed UUID', async () => {
  const f = fixture();
  f.setMode(async () => ({
    data: {
      ok: true,
      ...f.identity,
      state: 'ELIGIBLE',
      protocol_epoch: '1',
      enrollment_token: id(6),
    },
    error: null,
  }));
  await assert.rejects(f.session.admit(), /f06_enrollment_unproven/);
  assert.equal(f.calls.length, 1);
});
test('ACTIVE data with ok=false is not acknowledged admission', async () => {
  const f = fixture();
  f.setMode(async () => ({
    data: { ...f.identity, ok: false, state: 'ACTIVE', revision: '1' },
    error: null,
  }));
  await assert.rejects(f.session.admit());
  assert(!f.session.canStart());
});
for (const name of ['fn_f06_resolve_original_intent', 'fn_f06_allocate_original_intent'])
  test('intent RPC ok=false refuses even with matching fields ' + name, async () => {
    const f = fixture();
    await f.session.admit();
    await f.session.allocate();
    const original = { ...f.allocation() };
    f.setMode(async (n: any) => ({ data: { ...original, ok: n !== name }, error: null }));
    await assert.rejects(f.session.allocate());
  });
test('terminal intent pointer must name the original canonical permit', async () => {
  const f = fixture();
  await f.session.admit();
  await f.session.allocate();
  f.setIntent({
    ...f.allocation(),
    state: 'TERMINAL',
    canonical_terminal_verified: true,
    terminal_permit_id: id(999),
  });
  await assert.rejects(f.session.allocate(), /f06_intent_terminal_unproven/);
});
test('quarantine observation requires a latched original and grants no new start', async () => {
  const f = fixture();
  await f.session.admit();
  await assert.rejects(f.session.inspectQuarantine(), /f06_quarantine_fence_required/);
  f.session.fenceForRetirement();
  const before = f.calls.length;
  const row = await f.session.inspectQuarantine();
  assert.equal(row.intentState, 'NOT_RETAINED');
  assert.equal(row.admissionState, 'ACTIVE');
  assert(!f.session.canStart());
  assert.deepEqual(
    f.calls.slice(before).map((c: any) => c[0]),
    ['fn_f06_resolve_engine_admission']
  );
});
for (const state of ['INTENT', 'BOUND', 'TERMINAL'])
  test(
    'quarantine resolves retained original ' + state + ' without allocation or adoption',
    async () => {
      const f = fixture();
      await f.session.admit();
      await f.session.allocate();
      const old = {
        ...f.allocation(),
        state,
        canonical_terminal_verified: state === 'TERMINAL',
        terminal_permit_id: state === 'TERMINAL' ? id(10) : null,
      };
      f.session.fenceForRetirement();
      const before = f.calls.length;
      f.setMode(async (n: any) => ({
        data:
          n === 'fn_f06_resolve_engine_admission'
            ? {
                ok: true,
                ...f.identity,
                state: state === 'TERMINAL' ? 'TERMINAL' : 'RETIRING',
                revision: state === 'TERMINAL' ? '3' : '2',
              }
            : old,
        error: null,
      }));
      const row = await f.session.inspectQuarantine();
      assert.equal(row.intentState, state);
      assert(!f.session.canStart());
      assert.deepEqual(
        f.calls.slice(before).map((c: any) => c[0]),
        ['fn_f06_resolve_engine_admission', 'fn_f06_resolve_original_intent']
      );
    }
  );
for (const fault of ['foreign', 'revision', 'unknown', 'expired-original'])
  test('quarantine observation never substitutes authority ' + fault, async () => {
    const f = fixture();
    await f.session.admit();
    f.session.fenceForRetirement();
    f.setMode(async () => ({
      data:
        fault === 'unknown'
          ? { ok: false, state: 'UNKNOWN' }
          : {
              ok: true,
              ...f.identity,
              state: 'RETIRING',
              revision: fault === 'revision' ? '4' : '2',
              lease_generation: fault === 'foreign' ? id(999) : f.identity.lease_generation,
            },
      error: fault === 'expired-original' ? 'F06_LEASE_FENCED' : null,
    }));
    await assert.rejects(f.session.inspectQuarantine());
    assert(!f.session.canStart());
  });
