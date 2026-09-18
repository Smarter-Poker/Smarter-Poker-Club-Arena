import { it, expect, vi } from 'vitest';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { TournamentRetirementCustody } from './TournamentRetirementCustody.js';
import { F06HandPermit } from './F06HandPermit.js';
const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding = {
  breakId: id(1),
  tableId: id(2),
  tableIncarnation: '1',
  tournamentId: id(3),
  custodyId: id(4),
  durableRevision: '1',
  leaseGeneration: id(5),
};
async function specimen(attempted = false) {
  const engine: any = new ServerTableEngine(id(2));
  const hand = {
    tournament_id: id(3),
    lease_generation: id(5),
    table_id: id(2),
    lifecycle: '1',
    permit_id: id(6),
    hand_number: '1000001',
    custody_id: id(7),
  };
  let first = true;
  const rpc = vi.fn(async (name: string) => {
    if (name === 'fn_f06_begin_hand' && first) {
      first = false;
      return { data: null, error: 'lost' };
    }
    return {
      data: {
        ok: true,
        ...hand,
        generation: hand.lease_generation,
        evidence_id: binding.custodyId,
        state: name === 'fn_f06_begin_hand' ? 'reserved' : 'never_started',
      },
      error: null,
    };
  });
  const permit = new F06HandPermit(hand, rpc, () => true);
  await expect(permit.reserve()).rejects.toThrow('unproven');
  if (attempted) {
    await permit.reserve();
    permit.start(() => {});
  }
  // Process stop is the controlled external boundary; engine constructor,
  // custody service, no-start evidence and movement methods are actual code.
  Object.assign(engine, { f06CurrentPermit: permit, running: true });
  vi.spyOn(engine, 'stop').mockImplementation(async () => {
    engine.running = false;
    engine.terminal = true;
  });
  vi.spyOn(engine, 'hasReleasedProcessOwnership').mockReturnValue(true);
  return { engine, rpc };
}
const park = () =>
  Promise.resolve({
    ok: true,
    state: 'park_requested',
    break_id: id(1),
    custody_id: id(4),
    revision: '1',
    custody_generation: id(5),
    tournament_id: id(3),
    source_table_id: id(2),
    lifecycle: '1',
  });
it('constructed original goes from unknown BEGIN through durable no-start to actual movement execution', async () => {
  const { engine, rpc } = await specimen();
  const registry = new TournamentRetirementCustody<any>();
  const global = new Map([[id(2), engine]]),
    local = new Map([[id(2), engine]]);
  const moved: string[] = [];
  await registry.withCustody(
    binding,
    global,
    local,
    () => true,
    async (custody) => {
      expect(registry.admissionAllowed(id(2))).toBe(false);
      await engine.admitF06StoppedOriginalMovement(id(8), custody, park);
      expect(engine.getF06RetainedPermit()).toBeNull();
      expect(await engine.parkForTournamentMove(id(8), 0)).toBe(true);
      const result = await engine.executeTournamentMoveAtBoundary(id(8), async () => {
        moved.push('original occupancy moved');
        return 'canonical-move-ack';
      });
      expect(result).toBe('canonical-move-ack');
      expect(global.get(id(2))).toBe(engine);
      expect(local.get(id(2))).toBe(engine);
    },
    async () => {}
  );
  expect(moved).toHaveLength(1);
  expect(rpc.mock.calls.map((c) => c[0])).toEqual([
    'fn_f06_begin_hand',
    'fn_f06_finish_original_no_start',
  ]);
  // An escaped movement handle cannot outlive the two-map reservation.
  await expect(engine.executeTournamentMoveAtBoundary(id(8), async () => {})).rejects.toThrow(
    'stale'
  );
});
it('possible actuation never acquires a new stopped movement owner', async () => {
  const { engine } = await specimen(true);
  const registry = new TournamentRetirementCustody<any>();
  await expect(
    registry.withCustody(
      binding,
      new Map([[id(2), engine]]),
      new Map([[id(2), engine]]),
      () => true,
      (custody) => engine.admitF06StoppedOriginalMovement(id(8), custody, park),
      async () => {}
    )
  ).rejects.toThrow('may_have_started');
  expect(engine.hasClaimedTournamentMoveBoundary()).toBe(false);
  expect(registry.admissionAllowed(id(2))).toBe(false);
});
it('lost movement reply retains exact source reservation and supports exact-binding redrive', async () => {
  const { engine } = await specimen();
  const registry = new TournamentRetirementCustody<any>();
  const global = new Map([[id(2), engine]]),
    local = new Map([[id(2), engine]]);
  await expect(
    registry.withCustody(
      binding,
      global,
      local,
      () => true,
      async (custody) => {
        await engine.admitF06StoppedOriginalMovement(id(8), custody, park);
        await engine.executeTournamentMoveAtBoundary(id(8), async () => {
          throw new Error('move response lost');
        });
      },
      async () => {}
    )
  ).rejects.toThrow('move response lost');
  expect(global.get(id(2))).toBe(engine);
  expect(local.get(id(2))).toBe(engine);
  expect(registry.admissionAllowed(id(2))).toBe(false);
  await registry.withCustody(
    binding,
    global,
    local,
    () => true,
    async (custody) => {
      await engine.admitF06StoppedOriginalMovement(id(8), custody, park);
      expect(
        await engine.executeTournamentMoveAtBoundary(id(8), async () => 'same move durable receipt')
      ).toBe('same move durable receipt');
    },
    async () => {}
  );
});
it('map change during evidence await refuses before movement publication', async () => {
  const { engine } = await specimen();
  const registry = new TournamentRetirementCustody<any>();
  const global = new Map([[id(2), engine]]),
    local = new Map([[id(2), engine]]);
  await expect(
    registry.withCustody(
      binding,
      global,
      local,
      () => true,
      (custody) =>
        engine.admitF06StoppedOriginalMovement(id(8), custody, async () => {
          local.delete(id(2));
          return park();
        }),
      async () => {}
    )
  ).rejects.toThrow('registry_changed');
  expect(engine.hasClaimedTournamentMoveBoundary()).toBe(false);
});
