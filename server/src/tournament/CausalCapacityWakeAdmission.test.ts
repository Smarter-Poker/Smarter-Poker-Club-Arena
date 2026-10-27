import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), report: vi.fn() }));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { from: transport.from, rpc: transport.rpc },
  maintenanceSupabase: { from: transport.from, rpc: transport.rpc },
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError: transport.report,
  reportThrottled: vi.fn(),
}));

import { GameServer } from '../GameServer.js';
import { TournamentManager } from './TournamentManager.js';
import { setMaintenanceFrozen } from '../maintenance/freezeState.js';
import {
  bindTournamentDataAuthorityMethods,
  currentTournamentDataAuthority,
} from '../services/supabase/dataActorContext.js';

const EVENT = '00000000-0000-4000-8000-000000009918';
const TABLE = '00000000-0000-4000-8000-000000009919';
const LEASE = '00000000-0000-4000-8000-000000009920';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function query(result: unknown) {
  const value: any = {};
  for (const method of ['select', 'eq', 'is', 'order']) value[method] = vi.fn(() => value);
  value.limit = vi.fn(async () => result);
  value.maybeSingle = vi.fn(async () => result);
  return value;
}
function fixture() {
  const game: any = Object.assign(Object.create(GameServer.prototype), {
    running: true,
    lifecycleGeneration: 1,
    tournamentEngines: new Map(),
    acknowledgeTournamentManagerWakes: vi.fn(),
  });
  const manager: any = new TournamentManager(EVENT, game, LEASE, performance.now() + 60_000);
  manager.lifecycleEpoch.begin();
  manager.running = true;
  game.tournamentEngines.set(EVENT, manager);
  const engine = { setHub: vi.fn() };
  vi.spyOn(manager, 'createManagedTableEngine').mockReturnValue(engine);
  vi.spyOn(manager, 'wireEliminationWake').mockImplementation(() => {});
  vi.spyOn(manager, 'prepareManagedTableEngineForPlay').mockImplementation(() => {});
  vi.spyOn(manager, 'admitManagedTableEngine').mockImplementation(() => {});
  vi.spyOn(manager, 'startManagedTableEngine').mockImplementation(() => {});
  vi.spyOn(manager, 'broadcast').mockResolvedValue(undefined);
  vi.spyOn(manager, 'requestUrgentEliminationSweepAfter').mockImplementation(() => {});
  return { game, manager, engine };
}
const wake = {
  id: 918,
  generation: 1,
  tournament_id: EVENT,
  reason: 'late_registration',
  consumed_at: null,
};

beforeEach(() => {
  transport.from.mockReset();
  transport.rpc.mockReset();
  transport.report.mockReset();
  transport.from.mockImplementation((table: string) =>
    query({
      data:
        table === 'tournaments'
          ? { status: 'RUNNING' }
          : table === 'tournament_manager_wakes'
            ? []
            : [{ table_id: TABLE, created_at: new Date().toISOString() }],
      error: null,
    })
  );
  transport.rpc.mockResolvedValue({
    data: { ok: true, requested: 1, newly_admitted: 1 },
    error: null,
  });
});
afterEach(() => {
  setMaintenanceFrozen(false);
  vi.restoreAllMocks();
});

describe('committed capacity wakes do not wait for an unrelated full sweep', () => {
  it('binds the new public entry to the exact production manager data authority', async () => {
    const { game, manager } = fixture();
    const start = manager.startManagedTableEngine;
    const from = transport.from.getMockImplementation()!;
    const authorities: unknown[] = [];
    transport.from.mockImplementation((table) => {
      authorities.push(currentTournamentDataAuthority());
      return from(table);
    });
    bindTournamentDataAuthorityMethods({ tournamentId: EVENT, leaseGeneration: LEASE }, manager);
    expect(currentTournamentDataAuthority()).toBeNull();
    await game.admitTournamentManagerWake(wake);
    expect(start).toHaveBeenCalledOnce();
    expect(authorities).toEqual([
      { tournamentId: EVENT, leaseGeneration: LEASE },
      { tournamentId: EVENT, leaseGeneration: LEASE },
    ]);
    expect(currentTournamentDataAuthority()).toBeNull();
  });

  it('uses the original caller and manager to admit while the ordinary sweep remains unresolved', async () => {
    const { game, manager, engine } = fixture();
    const blocked = deferred<void>();
    vi.spyOn(manager, 'resumeCommittedTerminalCleanup').mockResolvedValue(false);
    vi.spyOn(manager, 'refreshChipCapInputs').mockReturnValue(blocked.promise);
    const ordinary = manager.runEliminationSweep(new AbortController().signal);
    await vi.waitFor(() => expect(manager.refreshChipCapInputs).toHaveBeenCalledOnce());
    expect(manager.isProcessingEliminations).toBe(true);
    // Scheduler registration is absent. Its original boolean stays false;
    // the committed-capacity handoff has an independent causal completion.
    expect(await game.admitTournamentManagerWake(wake)).toBe(false);
    expect(manager.isProcessingEliminations).toBe(true);
    expect(manager.startManagedTableEngine).toHaveBeenCalledWith(
      engine,
      'Tournament.dynamic_expansion_table_engine_error',
      { tableId: TABLE }
    );
    expect(manager.prepareManagedTableEngineForPlay).toHaveBeenCalledWith(engine);
    expect(transport.rpc).toHaveBeenCalledWith('fn_ack_tournament_capacity_tables', {
      p_tournament_id: EVENT,
      p_table_ids: [TABLE],
    });
    expect(game.acknowledgeTournamentManagerWakes).not.toHaveBeenCalled();
    expect(manager.pendingManagerWakes.get(918)).toBe('late_registration');
    manager.running = false;
    blocked.resolve();
    await ordinary;
  });

  it('does not inherit an aborted ordinary sweep signal or release its writer', async () => {
    const { game, manager } = fixture();
    const old = new AbortController();
    old.abort();
    manager.eliminationSweepSignal = old.signal;
    manager.isProcessingEliminations = true;
    await game.admitTournamentManagerWake(wake);
    expect(manager.startManagedTableEngine).toHaveBeenCalledOnce();
    expect(manager.isProcessingEliminations).toBe(true);
    expect(old.signal.aborted).toBe(true);
    expect(game.acknowledgeTournamentManagerWakes).not.toHaveBeenCalled();
  });

  it.each([
    'replacement',
    'stop',
    'lifecycle',
    'lease-expiry',
    'server-stop',
    'server-generation',
    'freeze',
    'finished',
    'f06',
  ])('refuses %s during the committed receipt read', async (change) => {
    const { game, manager } = fixture();
    const pending = deferred<any>();
    const receipt = query(null);
    receipt.limit.mockReturnValue(pending.promise);
    transport.from.mockReturnValue(receipt);
    const handoff = game.admitTournamentManagerWake(wake);
    await vi.waitFor(() => expect(receipt.limit).toHaveBeenCalledOnce());
    if (change === 'replacement') game.tournamentEngines.set(EVENT, {});
    if (change === 'stop') manager.running = false;
    if (change === 'lifecycle') manager.lifecycleEpoch.abort();
    if (change === 'lease-expiry') {
      vi.spyOn(manager, 'stop').mockResolvedValue(undefined);
      manager.tournamentLeaseProofDeadlineMonotonicMs = 0;
    }
    if (change === 'server-stop') game.running = false;
    if (change === 'server-generation') game.lifecycleGeneration++;
    if (change === 'freeze') setMaintenanceFrozen(true);
    if (change === 'finished') manager.tournamentFinished = true;
    if (change === 'f06') manager.f06RecoveryOwnership = true;
    pending.resolve({ data: [{ table_id: TABLE }], error: null });
    await handoff;
    expect(manager.startManagedTableEngine).not.toHaveBeenCalled();
    expect(transport.rpc).not.toHaveBeenCalled();
  });

  it.each(['hourly', 'addon', 'hand-for-hand', 'stage-end'])(
    'uses the existing real preparation for the %s hold before starting the dealer',
    async (hold) => {
      const { game, manager, engine } = fixture();
      Object.assign(engine, { pauseAfterHand: vi.fn(), holdDealingUntil: vi.fn() });
      manager.prepareManagedTableEngineForPlay.mockRestore();
      vi.spyOn(manager, 'holdManagedTableUntilBookedStart').mockImplementation(() => {});
      if (hold === 'hourly') manager.onBreak = true;
      if (hold === 'addon') {
        manager.addOnBreakActive = true;
        manager.addOnBreakOwnsPause = true;
        manager.addOnBreakEndsAtMs = Date.now() + 60_000;
      }
      if (hold === 'hand-for-hand') manager.handForHandActive = true;
      if (hold === 'stage-end') manager.stageEndPause = true;
      await game.admitTournamentManagerWake(wake);
      const paused = (engine as any).pauseAfterHand;
      expect(paused).toHaveBeenCalled();
      expect(paused.mock.invocationCallOrder[0]).toBeLessThan(
        manager.startManagedTableEngine.mock.invocationCallOrder[0]
      );
      if (hold === 'addon')
        expect((engine as any).holdDealingUntil).toHaveBeenCalledWith(manager.addOnBreakEndsAtMs);
    }
  );

  it.each(['COMPLETING', 'COMPLETED', 'CANCELLED', 'REGISTERING'])(
    'reads external %s authority after the receipt snapshot and leaves adoption to its owner',
    async (status) => {
      const { game, manager } = fixture();
      const pending = deferred<any>();
      const receipt = query(null);
      receipt.limit.mockReturnValue(pending.promise);
      transport.from.mockImplementation((table) =>
        table === 'tournaments' ? query({ data: { status }, error: null }) : receipt
      );
      const handoff = game.admitTournamentManagerWake(wake);
      await vi.waitFor(() => expect(receipt.limit).toHaveBeenCalledOnce());
      pending.resolve({ data: [{ table_id: TABLE }], error: null });
      await handoff;
      expect(manager.startManagedTableEngine).not.toHaveBeenCalled();
      expect(transport.rpc).not.toHaveBeenCalled();
      expect(game.acknowledgeTournamentManagerWakes).not.toHaveBeenCalled();
    }
  );

  it('reports unreadable terminal authority as unknown and keeps the wake', async () => {
    const { game, manager } = fixture();
    transport.from.mockImplementation((table) =>
      query(
        table === 'tournaments'
          ? { data: null, error: { message: 'unavailable' } }
          : { data: [{ table_id: TABLE }], error: null }
      )
    );
    await game.admitTournamentManagerWake(wake);
    expect(manager.startManagedTableEngine).not.toHaveBeenCalled();
    expect(transport.rpc).not.toHaveBeenCalled();
    expect(transport.report).toHaveBeenCalledWith(
      expect.anything(),
      'Tournament.capacity_wake_authority_unknown'
    );
    expect(manager.pendingManagerWakes.get(wake.id)).toBe('late_registration');
  });

  it('coalesces duplicate causes and an ordinary admission without concurrent receipt writers', async () => {
    const { game, manager } = fixture();
    const pending = deferred<any>();
    let reads = 0;
    let admitted = false;
    transport.from.mockImplementation((table) => {
      if (table === 'tournaments') return query({ data: { status: 'RUNNING' }, error: null });
      const receipt = query({ data: admitted ? [] : [{ table_id: TABLE }], error: null });
      receipt.limit.mockImplementation(() =>
        ++reads === 1
          ? pending.promise
          : Promise.resolve({ data: admitted ? [] : [{ table_id: TABLE }], error: null })
      );
      return receipt;
    });
    transport.rpc.mockImplementation(async () => {
      admitted = true;
      return { data: { ok: true, requested: 1, newly_admitted: 1 }, error: null };
    });
    const first = game.admitTournamentManagerWake(wake);
    const duplicate = game.admitTournamentManagerWake(wake);
    const ordinary = manager.admitCommittedCapacityTables();
    expect(reads).toBe(1);
    pending.resolve({ data: [{ table_id: TABLE }], error: null });
    await Promise.all([first, duplicate, ordinary]);
    expect(reads).toBe(2);
    expect(manager.createManagedTableEngine).toHaveBeenCalledOnce();
    expect(transport.rpc).toHaveBeenCalledOnce();
    expect(manager.capacityAdmissionOperation).toBeNull();
  });

  it('reads once more for a new generation committed after an older empty snapshot', async () => {
    const { game, manager } = fixture();
    const pending = deferred<any>();
    let reads = 0;
    transport.from.mockImplementation((table) => {
      if (table === 'tournaments') return query({ data: { status: 'RUNNING' }, error: null });
      const receipt = query({ data: [{ table_id: TABLE }], error: null });
      receipt.limit.mockImplementation(() =>
        ++reads === 1
          ? pending.promise
          : Promise.resolve({ data: [{ table_id: TABLE }], error: null })
      );
      return receipt;
    });
    const original = game.admitTournamentManagerWake(wake);
    const advanced = game.admitTournamentManagerWake({ ...wake, generation: 2 });
    pending.resolve({ data: [], error: null });
    await Promise.all([original, advanced]);
    expect(reads).toBe(2);
    expect(manager.createManagedTableEngine).toHaveBeenCalledOnce();
    expect(manager.pendingManagerWakeGenerations.get(wake.id)).toBe(2);
    expect(game.acknowledgeTournamentManagerWakes).not.toHaveBeenCalled();
  });

  it('continues its own cause after joining an ordinary admission that becomes aborted', async () => {
    const { game, manager } = fixture();
    const old = new AbortController();
    manager.eliminationSweepSignal = old.signal;
    manager.eliminationMutationAllowed = () => false;
    const pending = deferred<any>();
    let reads = 0;
    transport.from.mockImplementation((table) => {
      if (table === 'tournaments') return query({ data: { status: 'RUNNING' }, error: null });
      const receipt = query({ data: [{ table_id: TABLE }], error: null });
      receipt.limit.mockImplementation(() =>
        ++reads === 1
          ? pending.promise
          : Promise.resolve({ data: [{ table_id: TABLE }], error: null })
      );
      return receipt;
    });
    const ordinary = manager.admitCommittedCapacityTables();
    const cause = game.admitTournamentManagerWake(wake);
    old.abort();
    pending.resolve({ data: [{ table_id: TABLE }], error: null });
    await Promise.all([ordinary, cause]);
    expect(reads).toBe(2);
    expect(manager.createManagedTableEngine).toHaveBeenCalledOnce();
    expect(old.signal.aborted).toBe(true);
  });
});
