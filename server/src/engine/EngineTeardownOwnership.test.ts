import { describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { supabase } from '../services/supabase.js';
import { reportError } from '../services/errorReporter.js';
import * as db from '../services/supabase.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function rejectableDeferred(): {
  promise: Promise<void>;
  reject: (error: unknown) => void;
} {
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  return { promise, reject };
}

describe('table-engine lifecycle ownership', () => {
  it('shares one in-flight teardown promise and preserves it after completion', async () => {
    const tableId = '10101010-1010-4010-8010-101010101010';
    const flush = deferred();
    const engine = new ServerTableEngine(tableId) as any;
    expect(engine.claimProcessOwnership()).toBe(true);
    engine.running = true;
    engine.flushSnapshot = vi.fn(() => flush.promise);

    const first = engine.stop();
    const concurrent = engine.stop();
    expect(concurrent).toBe(first);
    expect(engine.running).toBe(false);
    await Promise.resolve();
    expect(engine.flushSnapshot).toHaveBeenCalledOnce();

    flush.resolve();
    await expect(first).resolves.toBeUndefined();
    expect(engine.stop()).toBe(first);
    await expect(engine.stop()).resolves.toBeUndefined();
    expect(engine.flushSnapshot).toHaveBeenCalledOnce();
  });

  it('rejects a cash-table teardown after snapshot failure without retaining ownership', async () => {
    const tableId = '20202020-2020-4020-8020-202020202020';
    const failure = new Error('snapshot flush failed');
    vi.mocked(reportError).mockClear();
    const engine = new ServerTableEngine(tableId) as any;
    expect(engine.claimProcessOwnership()).toBe(true);
    engine.running = true;
    engine.snapshotDirty = true;
    engine.saveSnapshot = vi.fn().mockRejectedValue(failure);

    const first = engine.stop();
    const concurrent = engine.stop();
    expect(concurrent).toBe(first);
    await expect(first).rejects.toMatchObject({ errors: [failure] });

    const late = engine.stop();
    expect(late).toBe(first);
    await expect(late).rejects.toMatchObject({ errors: [failure] });
    expect(engine.saveSnapshot).toHaveBeenCalledOnce();
    expect(engine.hasReleasedProcessOwnership()).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      failure,
      'ServerTableEngine.terminal_snapshot_flush_failed',
      { tableId }
    );
  });

  it('joins an already-running snapshot writer before releasing teardown ownership', async () => {
    const tableId = '21202020-2020-4020-8020-202020202020';
    const failure = new Error('in-flight snapshot failed');
    const snapshot = rejectableDeferred();
    const engine = new ServerTableEngine(tableId) as any;
    expect(engine.claimProcessOwnership()).toBe(true);
    engine.running = true;
    engine.snapshotDirty = true;
    engine.saveSnapshot = vi.fn(() => snapshot.promise);

    // Model requestSnapshot's best-effort writer already being in flight when
    // the owner fences the engine. The stop must join that exact promise even
    // though snapshotDirty was cleared before saveSnapshot awaited the DB.
    const gameplayFlush = engine.flushSnapshot();
    await Promise.resolve();
    expect(engine.snapshotDirty).toBe(false);

    const stopping = engine.stop();
    let settled = false;
    void stopping.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(engine.hasReleasedProcessOwnership()).toBe(false);

    const rejectedStop = expect(stopping).rejects.toMatchObject({ errors: [failure] });
    snapshot.reject(failure);
    await expect(gameplayFlush).resolves.toBeUndefined();
    await rejectedStop;
    expect(engine.saveSnapshot).toHaveBeenCalledOnce();
    expect(engine.snapshotFlushPromise).toBeNull();
    expect(engine.hasReleasedProcessOwnership()).toBe(true);
  });

  it('shares concurrent snapshot requests and chains one state change behind the active writer', async () => {
    const firstWrite = deferred();
    const secondWrite = deferred();
    const engine = new ServerTableEngine('21202020-2020-4020-8020-212020202020') as any;
    engine.saveSnapshot = vi
      .fn()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);

    engine.requestSnapshot();
    await Promise.resolve();
    expect(engine.saveSnapshot).toHaveBeenCalledOnce();

    // Bypass only the one-second coalescing delay so this proves two concurrent
    // requestSnapshot callers share the exact writer rather than testing the
    // timer. Exactly one follow-up write owns the second request's dirty state.
    engine.lastSnapshotAtMs = 0;
    engine.requestSnapshot();
    expect(engine.saveSnapshot).toHaveBeenCalledOnce();

    firstWrite.resolve();
    await vi.waitFor(() => expect(engine.saveSnapshot).toHaveBeenCalledTimes(2));
    secondWrite.resolve();
    await vi.waitFor(() => expect(engine.snapshotFlushPromise).toBeNull());
    expect(engine.snapshotDirty).toBe(false);
  });

  it('drains a successor snapshot before teardown releases process ownership', async () => {
    const firstWrite = deferred();
    const secondWrite = deferred();
    const tableId = '21202020-2020-4020-8020-312020202020';
    const engine = new ServerTableEngine(tableId) as any;
    expect(engine.claimProcessOwnership()).toBe(true);
    engine.running = true;
    engine.snapshotDirty = true;
    engine.saveSnapshot = vi
      .fn()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);

    const gameplayFlush = engine.flushSnapshot();
    await Promise.resolve();
    engine.snapshotDirty = true;
    const stopping = engine.stop();

    firstWrite.resolve();
    await vi.waitFor(() => expect(engine.saveSnapshot).toHaveBeenCalledTimes(2));
    expect(engine.hasReleasedProcessOwnership()).toBe(false);

    secondWrite.resolve();
    await expect(Promise.all([gameplayFlush, stopping])).resolves.toEqual([undefined, undefined]);
    expect(engine.snapshotFlushPromise).toBeNull();
    expect(engine.hasReleasedProcessOwnership()).toBe(true);
    await Promise.resolve();
    expect(engine.saveSnapshot).toHaveBeenCalledTimes(2);
  });

  it('keeps process ownership until an accepted settlement writer has finished', async () => {
    const tableId = '21212121-2121-4212-8212-212121212121';
    const settlement = deferred();
    const engine = new ServerTableEngine(tableId) as any;
    expect(engine.claimProcessOwnership()).toBe(true);
    engine.running = true;
    engine.postHandTasksPromise = settlement.promise;
    engine.trackSettlementInFlight(settlement.promise);
    engine.flushSnapshot = vi.fn(async () => undefined);

    const stopping = engine.stop();
    const successor = new ServerTableEngine(tableId) as any;
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(successor.claimProcessOwnership()).toBe(false);
    expect(engine.hasSettlementInFlight()).toBe(true);
    expect(engine.isDrained()).toBe(false);

    settlement.resolve();
    await expect(stopping).resolves.toBeUndefined();
    expect(engine.hasSettlementInFlight()).toBe(false);
    expect(successor.claimProcessOwnership()).toBe(true);
    await successor.stop();
  });

  it('a closed cluster table does not await the dealing loop from inside that loop', async () => {
    const tableId = '22212121-2121-4212-8212-212121212121';
    const loop = deferred();
    const flush = deferred();
    const engine = new ServerTableEngine(tableId) as any;
    expect(engine.claimProcessOwnership()).toBe(true);
    engine.running = true;
    engine.tableInfo = { cluster_id: 'cluster' };
    engine.seatedPlayers = [];
    engine.dealingLoopPromise = loop.promise;
    engine.flushSnapshot = vi.fn(() => flush.promise);
    const query: any = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({
        data: { lifecycle: 'closed', status: 'closed' },
        error: null,
      })),
    };
    const from = vi.spyOn(supabase, 'from').mockReturnValue(query);
    const successor = new ServerTableEngine(tableId) as any;
    let boundaryReturned = false;
    const closing = engine.stopIfClusterTableClosed().then(() => {
      boundaryReturned = true;
    });
    try {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(engine.running).toBe(false);
      expect(boundaryReturned).toBe(true);
      expect(engine.flushSnapshot).not.toHaveBeenCalled();
      expect(successor.claimProcessOwnership()).toBe(false);
      // The caller can now return from the captured dealing loop. Physical
      // teardown still owns both that loop and the later snapshot writer.
      loop.resolve();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(engine.flushSnapshot).toHaveBeenCalledOnce();
      expect(successor.claimProcessOwnership()).toBe(false);
      flush.resolve();
      await engine.stop();
      expect(successor.claimProcessOwnership()).toBe(true);
    } finally {
      // Also let the old-source counterexample dispose its exact owned work.
      loop.resolve();
      flush.resolve();
      await closing;
      await engine.stop();
      from.mockRestore();
      await successor.stop();
    }
  });

  it('retains ownership until an accepted seat cashout releases its boundary', async () => {
    const tableId = '23232323-2323-4232-8232-232323232323';
    const engine = new ServerTableEngine(tableId) as any;
    expect(engine.claimProcessOwnership()).toBe(true);
    engine.running = true;
    engine.flushSnapshot = vi.fn(async () => undefined);
    const release = await engine.acquireSeatBoundary();
    const stopping = engine.stop();
    const successor = new ServerTableEngine(tableId) as any;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(engine.flushSnapshot).not.toHaveBeenCalled();
    expect(successor.claimProcessOwnership()).toBe(false);
    await expect(engine.acquireSeatBoundary()).rejects.toThrow('Table Engine Is Stopping');
    release();
    await stopping;
    expect(engine.flushSnapshot).toHaveBeenCalledOnce();
    expect(successor.claimProcessOwnership()).toBe(true);
    await successor.stop();
  });

  it('retains an accepted preparation cashout when its sibling roster read fails', async () => {
    const tableId = '24242424-2424-4242-8242-242424242424';
    const engine = new ServerTableEngine(tableId) as any;
    expect(engine.claimProcessOwnership()).toBe(true);
    engine.running = true;
    engine.tableInfo = { club_id: 'club' };
    engine.pendingAddOnSweepNeeded = false;
    engine.flushSnapshot = vi.fn(async () => undefined);
    engine.readNextHandInputs = vi.fn(async () => {
      throw new Error('roster unavailable');
    });
    engine.allocateGlobalHandNumber = vi.fn(async () => 1);
    let finish!: () => void;
    const cashout = new Promise<[]>((resolve) => {
      finish = () => resolve([]);
    });
    const sweep = vi.spyOn(db, 'processLeavePending').mockReturnValue(cashout);
    let stopping: Promise<void> | undefined;
    const successor = new ServerTableEngine(tableId) as any;
    try {
      const preparation = engine.prepareNextHand();
      const preparationFailure = expect(preparation).rejects.toThrow('roster unavailable');
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(sweep).toHaveBeenCalledOnce();
      stopping = engine.stop();
      for (let i = 0; i < 15; i++) await Promise.resolve();
      expect(engine.flushSnapshot).not.toHaveBeenCalled();
      expect(successor.claimProcessOwnership()).toBe(false);
      finish();
      await preparationFailure;
      await stopping;
      expect(successor.claimProcessOwnership()).toBe(true);
    } finally {
      finish();
      await stopping;
      sweep.mockRestore();
      await successor.stop();
    }
  });

  it('an elapsed preparation budget cannot detach cashout or release the next hand boundary', async () => {
    vi.useFakeTimers();
    const engine = new ServerTableEngine('25252525-2525-4252-8252-252525252525') as any;
    engine.running = true;
    engine.tableInfo = { club_id: 'club' };
    engine.pendingAddOnSweepNeeded = false;
    engine.flushSnapshot = vi.fn(async () => undefined);
    const original = { user_id: 'player', seat_number: 1, occupancy_id: 'original', stack: 25 };
    const replacement = { ...original, occupancy_id: 'replacement', stack: 40 };
    engine.seatedPlayers = [original];
    engine.readNextHandInputs = vi.fn(async () => [original]);
    engine.allocateGlobalHandNumber = vi.fn(async () => 1);
    let finish!: () => void;
    const cashout = new Promise<Array<{ userId: string; occupancyId: string }>>((resolve) => {
      finish = () => resolve([{ userId: 'player', occupancyId: 'original' }]);
    });
    const sweep = vi.spyOn(db, 'processLeavePending').mockReturnValue(cashout);
    const failed = vi.fn();
    let releaseNext: (() => void) | undefined;
    try {
      const preparing = engine.prepareNextHand().catch(failed);
      await vi.advanceTimersByTimeAsync(120000);
      expect(sweep).toHaveBeenCalledOnce();
      expect(failed).not.toHaveBeenCalled();
      const nextBoundary = engine.acquireSeatBoundary().then((release: () => void) => {
        releaseNext = release;
      });
      await Promise.resolve();
      expect(releaseNext).toBeUndefined();
      engine.seatedPlayers = [replacement];
      finish();
      await preparing;
      await nextBoundary;
      expect(failed).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('deal_step_timeout: leave_pending'),
        })
      );
      expect(engine.seatedPlayers).toEqual([replacement]);
      expect(releaseNext).toBeTypeOf('function');
    } finally {
      finish();
      releaseNext?.();
      sweep.mockRestore();
      await engine.stop();
      vi.useRealTimers();
    }
  });

  it('makes a stopped generation terminal', async () => {
    const engine = new ServerTableEngine('30303030-3030-4030-8030-303030303030') as any;

    await engine.stop();
    await expect(engine.start()).rejects.toThrow(/terminal and cannot be restarted/);
  });

  it('will not evict another process-local generation when start races it', async () => {
    const tableId = '40404040-4040-4040-8040-404040404040';
    const incumbent = new ServerTableEngine(tableId) as any;
    const contender = new ServerTableEngine(tableId) as any;
    expect(incumbent.claimProcessOwnership()).toBe(true);

    await expect(contender.start()).rejects.toThrow(/another process-local generation/);
    expect(contender.running).toBe(false);

    await contender.stop();
    await incumbent.stop();
  });

  it('hands a detached runtime death to its owner exactly once', async () => {
    const engine = new ServerTableEngine('50505050-5050-4050-8050-505050505050');
    const restart = vi.fn();
    engine.onRestartRequired(restart);

    engine.killForRestartPublic('dealing_loop_threw');
    engine.killForRestartPublic('watchdog_duplicate');
    expect(restart).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(restart).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledWith('dealing_loop_threw');
    await engine.stop();
  });

  it('classifies the drill-only kill door separately from a real watchdog kill', async () => {
    const drill = new ServerTableEngine('51515151-5151-4515-8515-515151515151') as any;
    const drillEvent = vi.fn();
    drill.recordRecoveryEvent = drillEvent;
    drill.killForRestartPublic('dealing_loop_threw');
    expect(drillEvent).toHaveBeenCalledWith(
      'watchdog_kill_rebuild',
      'dealing_loop_threw',
      'fault_injection'
    );
    await drill.stop();

    const automatic = new ServerTableEngine('52525252-5252-4525-8525-525252525252') as any;
    const automaticEvent = vi.fn();
    automatic.recordRecoveryEvent = automaticEvent;
    automatic.killForRestart('dealing_loop_threw');
    expect(automaticEvent).toHaveBeenCalledWith(
      'watchdog_kill_rebuild',
      'dealing_loop_threw',
      'automatic_recovery'
    );
    await automatic.stop();
  });

  it('never lets a Vitest probe write engine recovery telemetry', () => {
    expect(process.env.VITEST).toBeTruthy();
    const from = vi.spyOn(supabase, 'from');
    try {
      const engine = new ServerTableEngine('53535353-5353-4535-8535-535353535353') as any;
      engine.recordRecoveryEvent('watchdog_kill_rebuild', 'synthetic_probe');
      expect(from).not.toHaveBeenCalled();
    } finally {
      from.mockRestore();
    }
  });

  it('keeps drill provenance through re-arm and escalation until kill or real progress', async () => {
    const engine = new ServerTableEngine('54545454-5454-4545-8545-545454545454') as any;
    engine.pendingRecoveryEventClass = 'fault_injection';

    // Tier 1 being recorded is not proof it worked. If the same injected stall
    // reaches Tier 3, the kill is still part of the drill.
    engine.recordRecoveryEvent('watchdog_rearm_clock', 'clock re-armed');
    expect(engine.pendingRecoveryEventClass).toBe('fault_injection');

    const terminalEvent = vi.fn();
    engine.recordRecoveryEvent = terminalEvent;
    engine.killForRestart('turn_unrecoverable');
    expect(terminalEvent).toHaveBeenCalledWith(
      'watchdog_kill_rebuild',
      'turn_unrecoverable',
      'fault_injection'
    );
    expect(engine.pendingRecoveryEventClass).toBeNull();
    await engine.stop();

    const recovered = new ServerTableEngine('55555555-5555-4555-8555-555555555555') as any;
    recovered.pendingRecoveryEventClass = 'fault_injection';
    recovered.markProgress();
    expect(recovered.pendingRecoveryEventClass).toBeNull();
    await recovered.stop();
  });

  it('does not manufacture a restart request for an intentional stop', async () => {
    const engine = new ServerTableEngine('60606060-6060-4060-8060-606060606060');
    const restart = vi.fn();
    engine.onRestartRequired(restart);

    await engine.stop();
    await Promise.resolve();
    expect(restart).not.toHaveBeenCalled();
  });

  it('lets a retired owner detach before a queued terminal signal runs', async () => {
    const engine = new ServerTableEngine('70707070-7070-4070-8070-707070707070');
    const restart = vi.fn();
    const detach = engine.onRestartRequired(restart);

    engine.killForRestartPublic('drill');
    detach();
    await Promise.resolve();
    expect(restart).not.toHaveBeenCalled();
    await engine.stop();
  });
});
