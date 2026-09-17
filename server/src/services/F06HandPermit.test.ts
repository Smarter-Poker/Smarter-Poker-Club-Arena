import { expect, it } from 'vitest';
import { F06HandPermit, verifyF06TerminationReceipt } from './F06HandPermit.js';
const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const b = {
  tournament_id: id(1),
  lease_generation: id(2),
  table_id: id(3),
  lifecycle: '9007199254740993',
  permit_id: id(4),
  hand_number: '9007199254740994',
  custody_id: id(5),
};
const proof = {
  evidence_id: id(6),
  process_boot_id: id(7),
  engine_generation: id(8),
  key_id: id(9),
  key: new Uint8Array(32).fill(7),
};
const data = {
  ok: true,
  tournament_id: b.tournament_id,
  generation: b.lease_generation,
  custody_id: b.custody_id,
  permit_id: b.permit_id,
  table_id: b.table_id,
  lifecycle: b.lifecycle,
  hand_number: b.hand_number,
  state: 'reserved',
};
it('binds exact bigint wire identity and refuses never-started after partial actuation', async () => {
  const p = new F06HandPermit(
    b,
    async (name, input) => {
      expect(name).toBe('fn_f06_begin_hand');
      expect(input.p_lifecycle).toBe(b.lifecycle);
      return { data, error: null };
    },
    () => true
  );
  await p.reserve();
  expect(() =>
    p.start(() => {
      throw new Error('partial');
    })
  ).toThrow('partial');
  await expect(
    p.terminateUnstarted(
      async () => {},
      () => true,
      proof
    )
  ).rejects.toThrow('may_have_started');
});
it('late reserve response cannot resurrect a terminated permit; signed proof binds lifecycle', async () => {
  let resolve!: (x: any) => void;
  const p = new F06HandPermit(
    b,
    () => new Promise((r) => (resolve = r)),
    () => true
  );
  const reserve = p.reserve();
  const receipt = await p.terminateUnstarted(
    async () => {},
    () => true,
    proof
  );
  resolve({ data, error: null });
  await expect(reserve).rejects.toThrow('owner_changed');
  expect(() => p.start(() => {})).toThrow();
  expect(verifyF06TerminationReceipt(receipt, proof.key)).toBe(true);
  expect(
    verifyF06TerminationReceipt({ ...receipt, lifecycle: '9007199254740995' }, proof.key)
  ).toBe(false);
});
it('stop callback without released/current custody cannot produce evidence', async () => {
  const p = new F06HandPermit(
    b,
    async () => ({ data, error: null }),
    () => true
  );
  await expect(
    p.terminateUnstarted(
      async () => {},
      () => false,
      proof
    )
  ).rejects.toThrow('unproven');
});
it('finish sends exact accepted evidence and rejects mismatched database acknowledgement', async () => {
  let finishing = false;
  const p = new F06HandPermit(
    b,
    async (name, input) => {
      if (name === 'fn_f06_begin_hand') return { data, error: null };
      finishing = true;
      expect(input.p_evidence_id).toBe(id(10));
      return {
        data: { ...data, state: 'accepted', evidence_id: id(10), lifecycle: '2' },
        error: null,
      };
    },
    () => true
  );
  await p.reserve();
  p.start(() => {});
  await expect(p.finish('accepted', id(10))).rejects.toThrow('finish_unproven');
  expect(finishing).toBe(true);
});
it('cannot finish never_started from a boolean or absent durable-evidence identity', async () => {
  const p = new F06HandPermit(
    b,
    async () => ({ data, error: null }),
    () => true
  );
  await expect(p.finish('never_started', id(10))).rejects.toThrow('evidence_missing');
});
it('uses current original-generation parked custody as evidence after positive no-start drain', async () => {
  const p = new F06HandPermit(
    b,
    async (name, input) => ({
      data: {
        ...data,
        evidence_id: input.p_evidence_id ?? null,
        state: name === 'fn_f06_finish_hand' ? 'never_started' : 'reserved',
      },
      error: null,
    }),
    () => true
  );
  await p.reserve();
  await p.drainNeverStarted(
    async () => {},
    () => true
  );
  const expected = { break_id: id(11), custody_id: id(12), revision: '9007199254740995' };
  await p.finishNeverStartedWithCustody(expected, async () => ({
    ok: true,
    state: 'park_requested',
    ...expected,
    custody_generation: b.lease_generation,
    tournament_id: b.tournament_id,
    source_table_id: b.table_id,
    lifecycle: b.lifecycle,
  }));
});
it('successor custody cannot dispose an old permit', async () => {
  const p = new F06HandPermit(
    b,
    async () => ({ data, error: null }),
    () => true
  );
  await p.drainNeverStarted(
    async () => {},
    () => true
  );
  const expected = { break_id: id(11), custody_id: id(12), revision: '1' };
  await expect(
    p.finishNeverStartedWithCustody(expected, async () => ({
      ok: true,
      state: 'park_requested',
      ...expected,
      custody_generation: id(13),
      tournament_id: b.tournament_id,
      source_table_id: b.table_id,
      lifecycle: b.lifecycle,
    }))
  ).rejects.toThrow('original_custody');
});
it('only explicit used-number refusal permits choosing another number', async () => {
  for (const reply of [
    { data: { ok: false, reason: 'hand_number_already_used' }, error: null },
    { data: null, error: new Error('lost') },
    { data: { ok: false, reason: 'source_excluded' }, error: null },
  ]) {
    const p = new F06HandPermit(
      b,
      async () => reply,
      () => true
    );
    await expect(p.reserve()).rejects.toThrow();
    expect(p.knownNumberRefusal()).toBe(reply.data?.reason === 'hand_number_already_used');
  }
});
