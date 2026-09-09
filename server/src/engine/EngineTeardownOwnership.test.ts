import { describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { supabase } from '../services/supabase.js';
import * as db from '../services/supabase.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

  it('never converts a failed teardown into a later successful no-op', async () => {
    const tableId = '20202020-2020-4020-8020-202020202020';
    const failure = new Error('snapshot flush failed');
    const engine = new ServerTableEngine(tableId) as any;
    expect(engine.claimProcessOwnership()).toBe(true);
    engine.running = true;
    engine.flushSnapshot = vi.fn(async () => Promise.reject(failure));

    const first = engine.stop();
    const concurrent = engine.stop();
    expect(concurrent).toBe(first);
    await expect(first).rejects.toMatchObject({ errors: [failure] });

    const late = engine.stop();
    expect(late).toBe(first);
    await expect(late).rejects.toMatchObject({ errors: [failure] });
    expect(engine.flushSnapshot).toHaveBeenCalledOnce();
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
