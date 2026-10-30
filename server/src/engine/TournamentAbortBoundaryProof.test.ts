import { afterEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../services/supabase/client.js', () => ({ supabase: io, maintenanceSupabase: {} }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';
import { ServerTableEngineBase } from './ServerTableEngineBase.js';
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
  it('parks a waiting original through the actual startup pause gate', async () => {
    const e = parked();
    e.handForHandResolve = null;
    e.parkedBankSaveComplete = false;
    const park = e.parkForTerminalCloseout(1_000);
    const gate = e.awaitPauseGate();
    expect(await park).toBe(true);
    await e.prepareTournamentAbortBoundary();
    expect(capture(e)).not.toBeNull();
    e.releaseTerminalCloseoutPause();
    await gate;
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
