import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameServer } from '../GameServer.js';
import type { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { reportError } from '../services/errorReporter.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class StopHarness extends TournamentManagerBase {
  quarantineResolved = true;
  addEngine(engine: ServerTableEngine) {
    this.tableEngines.set('table', engine);
  }
  hasEngine(engine: ServerTableEngine): boolean {
    return this.tableEngines.get('table') === engine;
  }
  callStopAndWait(): Promise<void> {
    return this.stopAndWait();
  }
  callFenceUnknownTerminalOutcome(errorContext: string): void {
    this.fenceUnknownTerminalOutcome(errorContext);
  }
  protected override async resolveTournamentSeatMoveQuarantine(): Promise<boolean> {
    return this.quarantineResolved;
  }
  protected override startEliminationChecker(): void {}
  protected override async recalculateEliminatedPrizes(): Promise<boolean> {
    return true;
  }
}

afterEach(() => vi.restoreAllMocks());

describe('manager owns table stop failures before awaiting another drain', () => {
  it('lets scheduler-owned terminal fencing return before teardown drains that same job', async () => {
    const unregister = vi.fn();
    const manager = new StopHarness(
      'aaaaaaaa-0000-4000-8000-000000000001',
      { unregisterTournamentTableEngine: unregister } as unknown as GameServer,
      'bbbbbbbb-0000-4000-8000-000000000001',
      performance.now() + 20_000
    );
    const schedulerJob = deferred();
    const engine = {
      stop: vi.fn(async () => undefined),
      hasReleasedProcessOwnership: () => true,
    } as unknown as ServerTableEngine;
    manager.addEngine(engine);
    vi.spyOn(manager as any, 'drainEliminationSchedulerJobs').mockReturnValue(schedulerJob.promise);

    expect(
      manager.callFenceUnknownTerminalOutcome('Tournament.test_unknown_terminal_stop_failed')
    ).toBeUndefined();
    expect(engine.stop).toHaveBeenCalledOnce();

    const teardown = manager.stop();
    let settled = false;
    void teardown.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    // This models the current registered sweep returning after the non-awaiting
    // fence. Only then may teardown drain that job and release ownership.
    schedulerJob.resolve();
    await expect(teardown).resolves.toBeUndefined();
    expect(unregister).toHaveBeenCalledWith('table', engine);
    expect(reportError).not.toHaveBeenCalledWith(
      expect.anything(),
      'Tournament.test_unknown_terminal_stop_failed',
      expect.anything()
    );
  });

  it.each([false, true])(
    'observes a fast rejection while scheduler work is held (released=%s)',
    async (released) => {
      const unregister = vi.fn();
      const manager = new StopHarness(
        'aaaaaaaa-0000-4000-8000-000000000001',
        {
          unregisterTournamentTableEngine: unregister,
        } as unknown as GameServer,
        'bbbbbbbb-0000-4000-8000-000000000001',
        performance.now() + 20_000
      );
      const scheduler = deferred();
      const tableStop = deferred();
      const then = vi.spyOn(tableStop.promise, 'then');
      const failure = new Error('authoritative hand commit was not proved');
      const engine = {
        // A plain method is deliberate: vi.fn observes returned promises itself.
        stop: () => tableStop.promise,
        hasReleasedProcessOwnership: () => released,
      } as unknown as ServerTableEngine;
      manager.addEngine(engine);
      vi.spyOn(manager as any, 'drainEliminationSchedulerJobs').mockReturnValue(scheduler.promise);
      const operation = manager.stop();
      const result = operation.then(
        () => null,
        (error: unknown) => error
      );
      const rejectionOwnedAtAdmission = then.mock.calls.some(
        ([, rejected]) => typeof rejected === 'function'
      );
      // The test's fallback keeps a failing assertion from emitting a process-
      // global rejection. Only the calls recorded BEFORE it prove ownership.
      void tableStop.promise.catch(() => undefined);
      tableStop.reject(failure);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unregister).not.toHaveBeenCalled();
      expect(manager.stop()).toBe(operation);
      scheduler.resolve();
      const error = await result;
      expect(rejectionOwnedAtAdmission).toBe(true);
      if (released) {
        expect(error).toBeNull();
        expect(reportError).toHaveBeenCalledWith(
          failure,
          'Tournament.table_engine_stop_cleanup_failed',
          { tableId: 'table' }
        );
        expect(unregister).toHaveBeenCalledWith('table', engine);
      } else {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toContain(failure);
        expect(unregister).not.toHaveBeenCalled();
      }
    }
  );

  it('does not let stopAndWait unregister a released engine with an unresolved move UUID', async () => {
    const unregister = vi.fn();
    const manager = new StopHarness(
      'aaaaaaaa-0000-4000-8000-000000000001',
      { unregisterTournamentTableEngine: unregister } as unknown as GameServer,
      'bbbbbbbb-0000-4000-8000-000000000001',
      performance.now() + 20_000
    );
    manager.quarantineResolved = false;
    const engine = {
      stop: vi.fn(async () => undefined),
      hasReleasedProcessOwnership: () => true,
    } as unknown as ServerTableEngine;
    manager.addEngine(engine);

    await expect(manager.callStopAndWait()).rejects.toBeInstanceOf(AggregateError);
    expect(unregister).not.toHaveBeenCalled();
    expect(manager.hasEngine(engine)).toBe(true);
  });
});
