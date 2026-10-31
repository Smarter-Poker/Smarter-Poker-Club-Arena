import { afterEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../services/supabase/client.js', () => ({ supabase: io, maintenanceSupabase: {} }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';
import { ServerTableEngineBase } from './ServerTableEngineBase.js';
import { TournamentManager } from '../tournament/TournamentManager.js';
const table = '00000000-0000-4000-8000-000000009801';
const tournament = '00000000-0000-4000-8000-000000009802';
const generation = '00000000-0000-4000-8000-000000009803';
const registry = (ServerTableEngineBase as any).liveEngines as Map<string, unknown>;
let engine: any;
afterEach(async () => {
  registry.delete(table);
  if (engine) {
    engine.running = false;
    await engine.stop();
  }
  vi.restoreAllMocks();
});
function parked() {
  engine = new ServerTableEngine(table, {
    scope: 'tournament',
    verified: true,
    tournamentId: tournament,
    generation,
    proofDeadlineMonotonicMs: performance.now() + 30_000,
  }) as any;
  engine.installF06Allocator(
    'abort-epoch',
    async () => 1,
    () => true,
    '19801'
  );
  engine.running = true;
  engine.terminalCloseoutPaused = true;
  engine.handForHandResolve = () => {};
  engine.parkedBankSaveComplete = true;
  registry.set(table, engine);
  return engine;
}
const capture = (e: any) => e.captureParkedTournamentAbortIdentity(table, tournament, generation);
describe('the real parked engine never certifies a retained writer as empty', () => {
  it('persists original stopped banks before the immutable seal and final manager stop writes none', async () => {
    const e = parked();
    let sealed = false;
    let writes = 0;
    io.rpc.mockImplementation(async (name: string, args: any) => {
      if (name === 'fn_park_stopped_time_bank_custody') {
        if (sealed) throw Error('CANCELLED_TOURNAMENT_EVIDENCE_IMMUTABLE');
        writes++;
        return {
          data: { ok: true, table_id: args.p_table_id, hand_number: args.p_hand_number },
          error: null,
        };
      }
      return { data: null, error: null };
    });
    e.tableInfo = { id: table, tournament_id: tournament, tournament_type: 'mtt' };
    e.adoptSeatRoster([
      { user_id: 'player', occupancy_id: 'original-stay', seat_number: 1, stack: 1500 },
    ]);
    e.timeBankEngine.initializePlayer(table, 'player', { remainingSeconds: 40, usesRemaining: 2 });
    e.timeBankMeta.set('player', { initialSeconds: 40, baseSeconds: 40, dbConsumedSeconds: 0 });
    await e.retireTournamentAbortBoundary();
    expect(e.captureStoppedTournamentAbortIdentity(table, tournament, generation)).not.toBeNull();
    expect(writes).toBe(1);
    const originalBank = e.stoppedTimeBankCustody;
    sealed = true;
    const manager = new TournamentManager(
      tournament,
      { unregisterTournamentTableEngine: vi.fn() } as any,
      generation,
      performance.now() + 30_000
    ) as any;
    manager.tableEngines.set(table, e);
    manager.resolveTournamentSeatMoveQuarantine = async () => true;
    await manager.stop();
    expect(writes).toBe(1);
    expect(e.stoppedTimeBankCustody).toBe(originalBank);
    expect(e.hasUnretiredStoppedTimeBankCustody()).toBe(false);
  });
  it('parks a waiting original through the actual startup pause gate', async () => {
    const e = parked();
    e.handForHandResolve = null;
    e.parkedBankSaveComplete = false;
    const park = e.parkForTournamentAbort(1_000);
    const gate = e.awaitPauseGate();
    expect(await park).toBe(true);
    await e.prepareTournamentAbortBoundary();
    expect(capture(e)).not.toBeNull();
    e.releaseTerminalCloseoutPause();
    await gate;
  });
  it('does not arm the startup gate in front of an accepted original restore', async () => {
    const e = parked();
    e.terminalCloseoutPaused = false;
    e.holdBeforeNextHand = false;
    e.handForHandResolve = null;
    e.pendingOriginalContinuation = { original: true };
    expect(await e.parkForTournamentAbort(1_000)).toBe(false);
    expect(e.terminalCloseoutPaused).toBe(false);
    expect(e.holdBeforeNextHand).toBe(false);
    e.pendingOriginalContinuation = null;
  });
  it('proves an exact parked original without exposing cards or player balances', () => {
    const e = parked();
    const result = capture(e);
    expect(result).toMatchObject({
      lifecycle: '19801',
      hand_number: 0,
      allocation_epoch: 'abort-epoch',
    });
    expect(Object.keys(result).sort()).toEqual([
      'allocation_epoch',
      'engine_id',
      'hand_number',
      'lifecycle',
    ]);
  });
  it.each([
    [
      'presence save',
      (e: any) => {
        e.presenceSavePending = 1;
      },
    ],
    [
      'accounting writer',
      (e: any) => {
        e.timeBankAccountingPending.add(Promise.resolve());
      },
    ],
    [
      'unknown debit',
      (e: any) => {
        e.unresolvedTimeBankDebits.set('original', {});
      },
    ],
    [
      'dirty snapshot',
      (e: any) => {
        e.snapshotDirty = true;
      },
    ],
    [
      'snapshot writer',
      (e: any) => {
        e.snapshotFlushPromise = Promise.resolve();
      },
    ],
    [
      'post-hand tail',
      (e: any) => {
        e.postHandTasksPromise = Promise.resolve();
      },
    ],
    [
      'accepted settlement',
      (e: any) => {
        e.settlementInFlight.add(Promise.resolve());
      },
    ],
    [
      'retained original',
      (e: any) => {
        e.pendingOriginalContinuation = {};
      },
    ],
    [
      'unwritten bank checkpoint',
      (e: any) => {
        e.parkedBankSaveComplete = false;
      },
    ],
    [
      'old engine instance',
      () => {
        registry.set(table, {});
      },
    ],
    [
      'hand still running',
      (e: any) => {
        e.handController = {};
      },
    ],
  ])('refuses %s', (_name, fault) => {
    const e = parked();
    expect(capture(e)).not.toBeNull();
    fault(e);
    expect(capture(e)).toBeNull();
    // Keep fixture teardown independent of the deliberately retained fake work.
    e.presenceSavePending = 0;
    e.timeBankAccountingPending.clear();
    e.unresolvedTimeBankDebits.clear();
    e.snapshotDirty = false;
    e.snapshotFlushPromise = null;
    e.postHandTasksPromise = null;
    e.settlementInFlight.clear();
    e.pendingOriginalContinuation = null;
    e.handController = null;
  });
  it('joins the actual presence promise before publishing a new parked bank receipt', async () => {
    const e = parked();
    let release!: () => void;
    e.presenceSave = new Promise<void>((resolve) => {
      release = resolve;
    });
    e.presenceSavePending = 1;
    e.persistPresenceForRestart = vi.fn(async () => {});
    e.flushSnapshot = vi.fn(async () => {});
    const proof = e.prepareTournamentAbortBoundary();
    await Promise.resolve();
    expect(e.persistPresenceForRestart).not.toHaveBeenCalled();
    e.presenceSavePending = 0;
    release();
    await proof;
    expect(e.persistPresenceForRestart).toHaveBeenCalledWith('parked');
  });
});
