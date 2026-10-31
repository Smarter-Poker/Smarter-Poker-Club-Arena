import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { ServerTableEngineBase } from './ServerTableEngineBase.js';
import { F06HandPermit } from '../services/F06HandPermit.js';

const io = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../services/supabase/client.js', () => ({ supabase: io, maintenanceSupabase: {} }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

const table = '00000000-0000-4000-8000-000000009701';
const tournament = '00000000-0000-4000-8000-000000009702';
const generation = '00000000-0000-4000-8000-000000009703';
const different = '00000000-0000-4000-8000-000000009704';
const args = [table, tournament, generation] as const;
const registry = (ServerTableEngineBase as any).liveEngines as Map<string, unknown>;

afterEach(() => {
  registry.delete(table);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function drained(): Promise<any> {
  const engine = new ServerTableEngine(table, {
    scope: 'tournament',
    verified: true,
    tournamentId: tournament,
    generation,
    proofDeadlineMonotonicMs: performance.now() + 30_000,
  }) as any;
  engine.installF06Allocator(
    'test-epoch',
    async () => 1,
    () => true,
    '1874947'
  );
  engine.flushSnapshot = vi.fn().mockResolvedValue(undefined);
  await engine.stop();
  expect(engine.drainedF06IdentityRefusal(...args)).toBeNull();
  expect(engine.captureDrainedF06Identity(...args)).not.toBeNull();
  return engine;
}

type Fault = [string, (engine: any) => void];
const pending = Promise.resolve();
const faults: Fault[] = [
  [
    'lifecycle_missing',
    (e) => {
      e.f06TableLifecycle = null;
    },
  ],
  [
    'lifecycle_invalid',
    (e) => {
      e.f06TableLifecycle = '0';
    },
  ],
  [
    'teardown_incomplete',
    (e) => {
      e.terminalTeardownComplete = false;
    },
  ],
  [
    'not_terminal',
    (e) => {
      e.terminal = false;
    },
  ],
  [
    'running',
    (e) => {
      e.running = true;
    },
  ],
  [
    'table_id_mismatch',
    (e) => {
      e.tableId = different;
    },
  ],
  [
    'live_engine_registered',
    (e) => {
      registry.set(table, e);
    },
  ],
  [
    'dealing_loop_pending',
    (e) => {
      e.dealingLoopPromise = pending;
    },
  ],
  [
    'settlement_pending',
    (e) => {
      e.settlementInFlight.add(pending);
    },
  ],
  [
    'post_hand_tasks_pending',
    (e) => {
      e.postHandTasksPromise = pending;
    },
  ],
  [
    'tournament_move_pending',
    (e) => {
      e.tournamentMoveOperations.add(pending);
    },
  ],
  [
    'tournament_move_owner_pending',
    (e) => {
      e.tournamentMoveOperationByOwner.set('owner', pending);
    },
  ],
  [
    'read_continuation_pending',
    (e) => {
      e.readContinuationTasks.add(pending);
    },
  ],
  [
    'snapshot_flush_pending',
    (e) => {
      e.snapshotFlushPromise = pending;
    },
  ],
  [
    'hand_controller_retained',
    (e) => {
      e.handController = { privateDeck: 'never-expose' };
    },
  ],
  [
    'terminal_boundary_pending',
    (e) => {
      e.terminalBoundaryPendingGenerations.add('boundary');
    },
  ],
  [
    'recovery_pending',
    (e) => {
      e.f06RecoveryInFlight = true;
    },
  ],
  [
    'presence_save_pending',
    (e) => {
      e.presenceSavePending = 1;
    },
  ],
  [
    'time_bank_accounting_pending',
    (e) => {
      e.timeBankAccountingPending.add(pending);
    },
  ],
  [
    'entry_hold_write_pending',
    (e) => {
      e.entryHoldWriteChains.set('entry', pending);
    },
  ],
  [
    'time_bank_accounting_unconfirmed',
    (e) => {
      e.timeBankAccountingUnconfirmed = true;
    },
  ],
  [
    'live_time_banks_retained',
    (e) => {
      vi.spyOn(e.timeBankEngine, 'hasPlayerBanksForTable').mockReturnValue(true);
    },
  ],
  [
    'disconnect_states_retained',
    (e) => {
      vi.spyOn(e.disconnectEngine, 'getFsmStatesForTable').mockReturnValue({
        privateUser: { private: 'never-expose' },
      });
    },
  ],
  [
    'lease_scope_mismatch',
    (e) => {
      e.engineLeaseScope = 'cash';
    },
  ],
  [
    'lease_unverified',
    (e) => {
      e.engineLeaseVerified = false;
    },
  ],
  [
    'tournament_id_mismatch',
    (e) => {
      e.engineLeaseTournamentId = different;
    },
  ],
  [
    'generation_mismatch',
    (e) => {
      e.engineLeaseGeneration = different;
    },
  ],
  [
    'hand_preparation_pending',
    (e) => {
      e.f06HandPreparation = {};
    },
  ],
];

describe('drained F06 physical identity refusal diagnostics', () => {
  it.each(faults)(
    'names %s without admitting the original or touching data',
    async (reason, fault) => {
      const engine = await drained();
      fault(engine);
      const before = Object.getOwnPropertyDescriptors(engine);
      const collections = () =>
        Object.fromEntries(
          Object.entries(engine)
            .filter(([, value]) => value instanceof Map || value instanceof Set)
            .map(([key, value]) => [key, [...(value as Map<unknown, unknown> | Set<unknown>)]])
        );
      const beforeCollections = collections();
      const rpcCalls = io.rpc.mock.calls.length;
      const reads = io.from.mock.calls.length;
      expect(engine.drainedF06IdentityRefusal(...args)).toBe(reason);
      expect(engine.captureDrainedF06Identity(...args)).toBeNull();
      expect(engine.drainedF06IdentityRefusal(...args)).toBe(reason);
      expect(Object.getOwnPropertyDescriptors(engine)).toEqual(before);
      expect(collections()).toEqual(beforeCollections);
      expect(io.rpc).toHaveBeenCalledTimes(rpcCalls);
      expect(io.from).toHaveBeenCalledTimes(reads);
      expect(reason).not.toContain('never-expose');
    }
  );

  it('keeps positive capture stable and uses movement lifecycle only when actually installed', async () => {
    const engine = await drained();
    const first = engine.captureDrainedF06Identity(...args);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toMatchObject({
      table_id: table,
      lifecycle: '1874947',
      allocation_epoch: 'test-epoch',
    });
    expect(engine.captureDrainedF06Identity(...args)).toEqual(first);
    engine.f06TableLifecycle = null;
    engine.f06MovementAdmission = { receipt: { lifecycle: '1874947' } };
    expect(engine.drainedF06IdentityRefusal(...args)).toBeNull();
    expect(engine.captureDrainedF06Identity(...args)?.lifecycle).toBe('1874947');
  });

  it('never invents local lifecycle from a retained original or reserved permit', async () => {
    const engine = await drained();
    engine.f06TableLifecycle = null;
    const original = Object.freeze({
      table_id: table,
      tournament_id: tournament,
      lifecycle: '1874947',
      hand_number: '51510628',
      lease_generation: generation,
      permit_id: different,
      custody_id: '00000000-0000-4000-8000-000000009705',
    });
    engine.pendingOriginalContinuation = Object.freeze({ original });
    engine.f06CurrentPermit = new F06HandPermit(
      original,
      io.rpc,
      () => false,
      () => false,
      generation
    );
    expect(engine.getF06RetainedPermit()).toMatchObject({ binding: original, phase: 'attempted' });
    const permitRead = vi.spyOn(engine, 'getF06RetainedPermit');
    const rpcCalls = io.rpc.mock.calls.length;
    expect(engine.drainedF06IdentityRefusal(...args)).toBe('lifecycle_missing');
    expect(engine.captureDrainedF06Identity(...args)).toBeNull();
    expect(engine.f06TableLifecycle).toBeNull();
    expect(engine.pendingOriginalContinuation.original).toBe(original);
    expect(permitRead).not.toHaveBeenCalled();
    expect(io.rpc).toHaveBeenCalledTimes(rpcCalls);
  });

  it('reports the first blocked predicate without hiding later custody work', async () => {
    const engine = await drained();
    engine.f06TableLifecycle = '';
    engine.readContinuationTasks.add(pending);
    expect(engine.drainedF06IdentityRefusal(...args)).toBe('lifecycle_missing');
    engine.f06TableLifecycle = '1874947';
    expect(engine.drainedF06IdentityRefusal(...args)).toBe('read_continuation_pending');
    expect(engine.captureDrainedF06Identity(...args)).toBeNull();
  });
});
