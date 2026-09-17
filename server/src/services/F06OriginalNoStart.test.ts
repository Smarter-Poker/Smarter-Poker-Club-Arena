import { it, expect, vi } from 'vitest';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { TournamentRetirementCustody } from './TournamentRetirementCustody.js';
import { F06HandPermit } from './F06HandPermit.js';
const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const original = {
  tournament_id: id(1),
  lease_generation: id(2),
  table_id: id(3),
  lifecycle: '1',
  permit_id: id(4),
  hand_number: '1000001',
  custody_id: id(5),
};
const binding = {
  tournamentId: id(1),
  leaseGeneration: id(2),
  tableId: id(3),
  tableIncarnation: '1',
  breakId: id(6),
  custodyId: id(7),
  durableRevision: '2',
};
const expected = { break_id: id(6), custody_id: id(7), revision: '2' };
const claim = () =>
  Promise.resolve({
    ok: true,
    state: 'park_requested',
    ...expected,
    custody_generation: id(2),
    tournament_id: id(1),
    source_table_id: id(3),
    lifecycle: '1',
  });
const envelope = () => ({
  ok: true,
  state: 'never_started',
  ...original,
  generation: id(2),
  evidence_id: id(7),
});
it.each(['committed_lost', 'absent', 'delayed_begin_first', 'late_after_disposition'])(
  'constructed original adapter consumes exact %s contract outcome',
  async (mode) => {
    const e: any = new ServerTableEngine(id(3));
    let durable: 'absent' | 'reserved' | 'never_started' = 'absent';
    let finishInput: any;
    let releaseLate!: (v: any) => void;
    const rpc = vi.fn(async (name: string, input: any) => {
      if (name === 'fn_f06_begin_hand') {
        if (mode === 'committed_lost') {
          durable = 'reserved';
          return { data: null, error: 'reply lost' };
        }
        if (mode === 'delayed_begin_first') {
          durable = 'reserved';
          return new Promise<any>((r) => (releaseLate = r));
        }
        return { data: null, error: 'not committed' };
      }
      expect(name).toBe('fn_f06_finish_original_no_start');
      finishInput = input;
      expect(input).toEqual({
        p_tournament_id: id(1),
        p_lease_generation: id(2),
        p_table_id: id(3),
        p_lifecycle: '1',
        p_permit_id: id(4),
        p_hand_number: '1000001',
        p_original_custody_id: id(5),
        p_break_id: id(6),
        p_park_custody_id: id(7),
        p_park_revision: '2',
      });
      durable = 'never_started';
      return { data: envelope(), error: null };
    });
    const permit = new F06HandPermit(original, rpc, () => true);
    const begin = permit.reserve();
    if (mode !== 'delayed_begin_first') await expect(begin).rejects.toThrow('unproven');
    Object.assign(e, { f06CurrentPermit: permit, running: true });
    vi.spyOn(e, 'stop').mockImplementation(async () => {
      e.running = false;
      e.terminal = true;
    });
    vi.spyOn(e, 'hasReleasedProcessOwnership').mockReturnValue(true);
    const registry = new TournamentRetirementCustody<any>();
    const global = new Map([[id(3), e]]),
      local = new Map([[id(3), e]]);
    await registry.withCustody(
      binding,
      global,
      local,
      () => true,
      async (custody) => {
        await e.admitF06StoppedOriginalMovement(id(8), custody, claim);
        expect(e.getF06RetainedPermit()).toBeNull();
        expect(
          await e.executeTournamentMoveAtBoundary(id(8), async () => 'move acknowledged')
        ).toBe('move acknowledged');
      },
      async () => {}
    );
    expect(durable).toBe('never_started');
    expect(finishInput.p_original_custody_id).not.toBe(finishInput.p_park_custody_id);
    if (mode === 'delayed_begin_first') {
      releaseLate({ data: { ok: true, ...original, state: 'reserved' }, error: null });
      await expect(begin).rejects.toThrow('owner_changed');
      expect(() => permit.start(() => {})).toThrow('unproven');
    }
    if (mode === 'late_after_disposition') {
      // Contract return from Accounting tombstone-first qualification, not native SQL here.
      const late = new F06HandPermit(
        original,
        async () => ({ data: { ...envelope(), ok: false }, error: null }),
        () => true
      );
      await expect(late.reserve()).rejects.toThrow('unproven');
      expect(() => late.start(() => {})).toThrow('unproven');
    }
  }
);
it.each([
  'tournament_id',
  'table_id',
  'permit_id',
  'lifecycle',
  'hand_number',
  'custody_id',
  'generation',
  'evidence_id',
])('full response mismatch %s preserves original permit', async (field) => {
  const e: any = new ServerTableEngine(id(3));
  const p = new F06HandPermit(
    original,
    async () => ({ data: { ...envelope(), [field]: 'wrong' }, error: null }),
    () => true
  );
  e.f06CurrentPermit = p;
  await p.drainNeverStarted(
    async () => {},
    () => true
  );
  await expect(e.finishF06OriginalNoStart(expected, claim)).rejects.toThrow('unproven');
  expect(e.f06CurrentPermit).toBe(p);
});
it('unknown finish reply replays identical ten args and retains original until validated', async () => {
  let calls = 0;
  const args: unknown[] = [];
  const e: any = new ServerTableEngine(id(3));
  const p = new F06HandPermit(
    original,
    async (_, input) => {
      args.push(input);
      return ++calls === 1 ? { data: null, error: 'lost' } : { data: envelope(), error: null };
    },
    () => true
  );
  e.f06CurrentPermit = p;
  await p.drainNeverStarted(
    async () => {},
    () => true
  );
  await expect(e.finishF06OriginalNoStart(expected, claim)).rejects.toThrow('unproven');
  expect(e.f06CurrentPermit).toBe(p);
  await e.finishF06OriginalNoStart(expected, claim);
  expect(args[1]).toEqual(args[0]);
  expect(e.f06CurrentPermit).toBeNull();
});
it('ownership lost during disposition rejects successful reply and preserves original', async () => {
  let current = true;
  const e: any = new ServerTableEngine(id(3));
  const p = new F06HandPermit(
    original,
    async () => {
      current = false;
      return { data: envelope(), error: null };
    },
    () => current
  );
  e.f06CurrentPermit = p;
  await p.drainNeverStarted(
    async () => {},
    () => true
  );
  await expect(e.finishF06OriginalNoStart(expected, claim)).rejects.toThrow('unproven');
  expect(e.f06CurrentPermit).toBe(p);
});
