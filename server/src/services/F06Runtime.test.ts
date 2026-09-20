import { expect, it, vi } from 'vitest';
import { GameServer } from '../GameServer.js';
import { ServerTableEngineBase } from '../engine/ServerTableEngineBase.js';
import { ServerTableEngineDealing } from '../engine/ServerTableEngineDealing.js';
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
function server() {
  const s: any = Object.create(GameServer.prototype);
  Object.assign(s, {
    running: true,
    tableEngines: new Map(),
    tournamentOwnedTables: new Set(),
    maintenanceBreak: { adopt: vi.fn() },
    tournamentRetirementCustody: new TournamentRetirementCustody(),
  });
  return s;
}
it('actual GameServer registration and replacement refuse held retirement custody', async () => {
  const s = server();
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const held = s.withRetirementCustody(
    binding,
    new Map(),
    () => true,
    () => wait,
    async () => {}
  );
  const engine = { hasClaimedTournamentMoveBoundary: () => false };
  expect(s.registerTableEngine(binding.tableId, engine)).toBe(false);
  expect(await s.replaceTableEngine(binding.tableId, engine, {})).toBe(false);
  release();
  await held;
  expect(s.registerTableEngine(binding.tableId, engine)).toBe(true);
});
it('actual Base retains unknown original permit and refuses a replacement', async () => {
  const e: any = Object.create(ServerTableEngineBase.prototype);
  Object.assign(e, { running: false, f06PermitFactory: null, f06CurrentPermit: null });
  const b = {
    tournament_id: id(3),
    lease_generation: id(5),
    table_id: id(2),
    lifecycle: '1',
    permit_id: id(6),
    hand_number: '1000001',
    custody_id: id(4),
  };
  e.installF06HandAdmission(
    () =>
      new F06HandPermit(
        b,
        async () => ({ data: null, error: new Error('lost') }),
        () => true
      )
  );
  e.running = true;
  await expect(e.reserveF06Hand(1000001)).rejects.toThrow('unproven');
  const original = e.f06CurrentPermit;
  await expect(e.reserveF06Hand(1000002)).rejects.toThrow('prior_hand_unresolved');
  expect(e.f06CurrentPermit).toBe(original);
});
it('real Dealing method waits for permit before preparing or starting a hand', async () => {
  const e: any = Object.create(ServerTableEngineDealing.prototype);
  const release = vi.fn();
  let permitReject!: (e: Error) => void;
  const roster = [
    { user_id: id(1), seat_number: 1, occupancy_id: id(11) },
    { user_id: id(2), seat_number: 2, occupancy_id: id(12) },
  ];
  Object.assign(e, {
    seatedPlayers: roster,
    tableInfo: {},
    handCount: 0,
    running: true,
    tournamentMovePauseOwners: new Set(),
    acquireSeatBoundary: async () => release,
    isTournamentTable: () => true,
    takePreparedHandNumber: () => null,
    allocateGlobalHandNumber: async () => 1000001,
    reserveF06Hand: () => new Promise((_, reject) => (permitReject = reject)),
    discardPreparedHandForPause: vi.fn(),
  });
  const work = e.dealHand(roster);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(e.discardPreparedHandForPause).not.toHaveBeenCalled();
  permitReject(new Error('excluded'));
  await expect(work).rejects.toThrow('excluded');
  expect(release).toHaveBeenCalledOnce();
});
it('actual GameServer adapter retains admission fence across lost cleanup ACK and exact replay', async () => {
  const s = server();
  const local = new Map();
  let prepared = 0;
  await expect(
    s.withRetirementCustody(
      binding,
      local,
      () => true,
      async (c: any) => {
        expect(c.engine).toBeNull();
        c.confirmAbsent();
        throw new Error('ack lost');
      },
      async () => {
        prepared++;
      }
    )
  ).rejects.toThrow('ack lost');
  expect(s.registerTableEngine(binding.tableId, {})).toBe(false);
  await s.withRetirementCustody(
    binding,
    local,
    () => true,
    async (c: any) => {
      c.confirmAbsent();
      return 'acknowledged';
    },
    async () => {
      prepared++;
    }
  );
  expect(prepared).toBe(2);
  expect(s.registerTableEngine(binding.tableId, {})).toBe(true);
});
it('actual GameServer adapter does not invoke close after generation changes during stop', async () => {
  const s = server();
  let valid = true;
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const engine = { stop: () => wait, hasReleasedProcessOwnership: () => true };
  s.tableEngines.set(binding.tableId, engine);
  const local = new Map([[binding.tableId, engine]]);
  const close = vi.fn();
  const result = s.withRetirementCustody(
    binding,
    local,
    () => valid,
    close,
    async () => {}
  );
  await Promise.resolve();
  valid = false;
  release();
  await expect(result).rejects.toThrow('stale');
  expect(close).not.toHaveBeenCalled();
});
it('actual Base accepted finish clears only exact permit after durable acknowledgement', async () => {
  const e: any = Object.create(ServerTableEngineBase.prototype);
  let resolve!: (v: any) => void;
  const b = {
    tournament_id: id(3),
    lease_generation: id(5),
    table_id: id(2),
    lifecycle: '1',
    permit_id: id(6),
    hand_number: '1000001',
    custody_id: id(4),
  };
  const reply = {
    ok: true,
    tournament_id: b.tournament_id,
    generation: b.lease_generation,
    custody_id: b.custody_id,
    permit_id: b.permit_id,
    table_id: b.table_id,
    lifecycle: b.lifecycle,
    hand_number: b.hand_number,
  };
  const p = new F06HandPermit(
    b,
    async (name) =>
      name === 'fn_f06_begin_hand'
        ? { data: { ...reply, state: 'reserved' }, error: null }
        : new Promise((r) => (resolve = r)),
    () => true
  );
  await p.reserve();
  p.start(() => {});
  e.f06CurrentPermit = p;
  const finish = e.finishF06AcceptedHand('1000001', id(9));
  expect(e.f06CurrentPermit).toBe(p);
  resolve({ data: { ...reply, state: 'accepted', evidence_id: id(9) }, error: null });
  await finish;
  expect(e.f06CurrentPermit).toBeNull();
});
it('actual Manager shared admission starts only after resolved projection and provider installation', async () => {
  const { TournamentManagerBase } = await import('../tournament/TournamentManagerBase.js');
  const { supabase } = await import('./supabase.js');
  for (const unresolved of [false, true]) {
    const manager: any = Object.create(TournamentManagerBase.prototype);
    const order: string[] = [];
    const token = {};
    const bookedStartMs = Date.now() + 60_000;
    const engine = {
      ready: Promise.resolve(true),
      holdDealingUntil: (deadline: number) => {
        expect(deadline).toBe(bookedStartMs);
        order.push('booked-start-held');
      },
      installF06Allocator: () => {},
      installF06HandAdmission: () => order.push('installed'),
      start: async () => {
        order.push('started');
      },
    };
    Object.assign(manager, {
      tournamentId: id(3),
      tournamentCache: { started_at: new Date(bookedStartMs).toISOString() },
      tournamentLeaseGeneration: id(5),
      lifecycleEpoch: { current: () => token },
      lifecycleIsCurrent: () => true,
      tableIdForManagedEngine: () => id(2),
      tableEngines: new Map([[id(2), engine]]),
      tableEngineRunJobs: new Set(),
      tableEngineStartJobs: new Set(),
      clearManagedTableEngineRecovery: () => {},
      gameServer: {
        ownsTournamentTableEngine: () => true,
        tournamentRetirementCustody: { admissionAllowed: () => true },
      },
      recoverManagedTableEngine: async () => {
        order.push('recovery');
      },
    });
    const spy = vi.spyOn(supabase, 'rpc').mockImplementation((async (name: string) => {
      if (name === 'fn_ca_resume_hand_submission') {
        return { data: { found: false }, error: null } as never;
      }
      expect(name).toBe('fn_f06_hand_number_state');
      return {
        data: {
          ok: true,
          table_id: id(2),
          lifecycle: '1',
          can_reserve: !unresolved,
          blocked_reason: unresolved ? 'hand_permit_unresolved' : null,
          used_hand_number_max: '1000000',
          next_hand_number_candidate: unresolved ? null : '1000001',
          unresolved_permit: unresolved ? { permit_id: id(6) } : null,
        },
        error: null,
      } as never;
    }) as never);
    manager.startManagedTableEngine(engine, 'test');
    await Promise.all([...manager.tableEngineRunJobs]);
    expect(spy.mock.calls.map(([name]) => name)).toEqual([
      'fn_ca_resume_hand_submission',
      'fn_f06_hand_number_state',
    ]);
    spy.mockRestore();
    expect(order).toEqual(
      unresolved ? ['booked-start-held', 'recovery'] : ['booked-start-held', 'installed', 'started']
    );
  }
});
it('actual Base no-start drain retains original permit until exact custody evidence finishes', async () => {
  const e: any = Object.create(ServerTableEngineBase.prototype);
  let stopped = false;
  const b = {
    tournament_id: id(3),
    lease_generation: id(5),
    table_id: id(2),
    lifecycle: '1',
    permit_id: id(6),
    hand_number: '1000001',
    custody_id: id(4),
  };
  const p = new F06HandPermit(
    b,
    async (name) => ({
      data: {
        ok: true,
        ...b,
        generation: b.lease_generation,
        state: name === 'fn_f06_begin_hand' ? 'reserved' : 'never_started',
        evidence_id: name === 'fn_f06_begin_hand' ? null : b.custody_id,
      },
      error: null,
    }),
    () => true
  );
  await p.reserve();
  Object.assign(e, {
    f06CurrentPermit: p,
    stop: async () => {
      stopped = true;
    },
    hasReleasedProcessOwnership: () => stopped,
  });
  await e.drainF06NeverStarted();
  expect(e.f06CurrentPermit).toBe(p);
  expect(() => p.start(() => {})).toThrow();
  const expected = { break_id: id(1), custody_id: id(4), revision: '1' };
  await e.finishF06NeverStarted(expected, async () => ({
    ok: true,
    ...expected,
    state: 'park_requested',
    custody_generation: b.lease_generation,
    tournament_id: b.tournament_id,
    source_table_id: b.table_id,
    lifecycle: b.lifecycle,
  }));
  expect(e.f06CurrentPermit).toBeNull();
});
it('actual Base F06 allocator never retries or falls back after unknown response', async () => {
  const e: any = Object.create(ServerTableEngineBase.prototype);
  Object.assign(e, { running: false, f06Allocator: null });
  let calls = 0;
  e.installF06Allocator(
    'epoch',
    async () => {
      calls++;
      throw new Error('allocation lost');
    },
    () => true
  );
  await expect(e.allocateGlobalHandNumber()).rejects.toThrow('allocation lost');
  expect(calls).toBe(1);
});
it('actual Base rejects allocation after owner loss and Dealing discards stale prepared epoch', async () => {
  const e: any = Object.create(ServerTableEngineBase.prototype);
  Object.assign(e, { running: false, f06Allocator: null });
  let current = true;
  e.installF06Allocator(
    'epoch',
    async () => {
      current = false;
      return 1000001;
    },
    () => current
  );
  await expect(e.allocateGlobalHandNumber()).rejects.toThrow('unproven');
  const d: any = Object.create(ServerTableEngineDealing.prototype);
  Object.assign(d, {
    preparedF06AllocationError: null,
    preparedHandNumberValue: { n: 1000001, at: Date.now(), epoch: 'old' },
    f06AllocationEpoch: 'new',
    f06Allocator: null,
  });
  expect(() => d.takePreparedHandNumber()).toThrow('epoch_stale');
  expect(d.preparedHandNumberValue).toBeNull();
});
it('ordinary Base allocation still calls the legacy RPC', async () => {
  const { supabase } = await import('./supabase.js');
  const spy = vi
    .spyOn(supabase, 'rpc')
    .mockResolvedValue({ data: '1000002', error: null } as never);
  const e: any = Object.create(ServerTableEngineBase.prototype);
  e.f06Allocator = null;
  expect(await e.allocateGlobalHandNumber()).toBe(1000002);
  expect(spy).toHaveBeenCalledWith('fn_next_hand_number');
  spy.mockRestore();
});

it.each(['reservation', 'movement', 'none'])(
  'actual replacement cleanup error respects new %s boundary',
  async (kind) => {
    const s = server();
    let reject!: (e: Error) => void;
    let claimed = false;
    const incumbent = {
      stop: () => new Promise<void>((_, r) => (reject = r)),
      hasReleasedProcessOwnership: () => true,
      hasClaimedTournamentMoveBoundary: () => claimed,
    };
    const replacement = {};
    s.tableEngines.set(binding.tableId, incumbent);
    const pending = s.replaceTableEngine(binding.tableId, incumbent, replacement);
    await Promise.resolve();
    let release!: () => void;
    let held: Promise<unknown> | undefined;
    if (kind === 'reservation')
      held = s.tournamentRetirementCustody.withAdmission(
        binding.tableId,
        () => true,
        () => new Promise<void>((r) => (release = r))
      );
    if (kind === 'movement') claimed = true;
    reject(new Error('cleanup diagnostic'));
    if (kind === 'none') {
      expect(await pending).toBe(true);
      expect(s.tableEngines.get(binding.tableId)).toBe(replacement);
    } else {
      await expect(pending).rejects.toThrow('cleanup diagnostic');
      expect(s.tableEngines.get(binding.tableId)).toBe(incumbent);
    }
    if (held) {
      expect(s.tournamentRetirementCustody.admissionAllowed(binding.tableId)).toBe(false);
      release();
      await held;
    }
  }
);
it('actual original permit recovery replays identical BEGIN and rejects owner loss', async () => {
  const e: any = Object.create(ServerTableEngineBase.prototype);
  let current = true;
  let calls = 0;
  const inputs: unknown[] = [];
  const b = {
    tournament_id: id(3),
    lease_generation: id(5),
    table_id: id(2),
    lifecycle: '1',
    permit_id: id(6),
    hand_number: '1000001',
    custody_id: id(4),
  };
  const permit = new F06HandPermit(
    b,
    async (_, input) => {
      inputs.push(input);
      calls++;
      return calls === 1
        ? { data: null, error: 'lost' }
        : {
            data: { ok: true, ...b, generation: b.lease_generation, state: 'reserved' },
            error: null,
          };
    },
    () => current
  );
  Object.assign(e, { running: true, f06CurrentPermit: permit, f06RecoveryInFlight: false });
  await expect(permit.reserve()).rejects.toThrow('unproven');
  await e.replayF06OriginalPermit({ ...b }, () => current);
  expect(inputs[1]).toEqual(inputs[0]);
  expect(e.f06CurrentPermit).toBe(permit);
  current = false;
  await expect(e.replayF06OriginalPermit(b, () => current)).rejects.toThrow('owner_changed');
  expect(calls).toBe(2);
});
it('actual recovery rejects changed map during delayed reply and preserves original', async () => {
  const e: any = Object.create(ServerTableEngineBase.prototype);
  let resolve!: (v: any) => void;
  let owner = true;
  let calls = 0;
  const b = {
    tournament_id: id(3),
    lease_generation: id(5),
    table_id: id(2),
    lifecycle: '1',
    permit_id: id(6),
    hand_number: '1000001',
    custody_id: id(4),
  };
  const p = new F06HandPermit(
    b,
    async () => (++calls === 1 ? { data: null, error: 'lost' } : new Promise((r) => (resolve = r))),
    () => owner
  );
  Object.assign(e, { running: true, f06CurrentPermit: p });
  await expect(p.reserve()).rejects.toThrow();
  const retry = e.replayF06OriginalPermit(b, () => owner);
  await expect(e.replayF06OriginalPermit(b, () => owner)).rejects.toThrow('in_flight');
  owner = false;
  resolve({ data: { ok: true, ...b, state: 'reserved' }, error: null });
  await expect(retry).rejects.toThrow('owner_changed');
  expect(e.f06CurrentPermit).toBe(p);
});

it('actual allocation recovery is one-shot and cannot discard an unknown BEGIN', async () => {
  const e: any = Object.create(ServerTableEngineDealing.prototype);
  const failure = new Error('allocation lost');
  let calls = 0;
  Object.assign(e, {
    running: true,
    f06Allocator: async () => {
      calls++;
      return 1000002;
    },
    f06AllocationCurrent: () => true,
    f06AllocationEpoch: 'epoch',
    f06CurrentPermit: null,
    preparedHandNumber: null,
    preparedF06AllocationError: failure,
  });
  const ticket = e.getF06FailedAllocation();
  e.f06CurrentPermit = {};
  await expect(e.retryF06FailedAllocation(ticket, () => true)).rejects.toThrow('unproven');
  expect(calls).toBe(0);
  e.f06CurrentPermit = null;
  await e.retryF06FailedAllocation(ticket, () => true);
  expect(calls).toBe(1);
  expect(e.takePreparedHandNumber()).toBe(1000002);
  expect(e.getF06FailedAllocation()).toBeNull();
  await expect(e.retryF06FailedAllocation(ticket, () => true)).rejects.toThrow('unproven');
});
it('actual allocation recovery burns late success after ownership change', async () => {
  const e: any = Object.create(ServerTableEngineDealing.prototype);
  const failure = new Error('lost');
  let current = true;
  Object.assign(e, {
    running: true,
    f06Allocator: async () => {
      current = false;
      return 1000002;
    },
    f06AllocationCurrent: () => current,
    f06AllocationEpoch: 'epoch',
    f06CurrentPermit: null,
    preparedHandNumber: null,
    preparedHandNumberValue: null,
    preparedF06AllocationError: failure,
  });
  await expect(
    e.retryF06FailedAllocation(e.getF06FailedAllocation(), () => current)
  ).rejects.toThrow('unproven');
  expect(e.preparedHandNumberValue).toBeNull();
  expect(e.preparedF06AllocationError).toBe(failure);
});
